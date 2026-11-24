// Runtime of the paridad Go SDK (vault/CONTRACT.md §5): configuration, authentication,
// typed errors, the retry and idempotency policy of §5.3, per-attempt timeouts,
// cursor pagination and debug output, with the standard library only. Static
// template copied by the generator; the policy constants come from the IR
// (policy.go) and the services and methods are generated from its operations
// (services.go).

package resend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"maps"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// UserAgent is sent on every request.
const UserAgent = "paridad-go/" + Version

const (
	defaultBaseURL   = "https://api.resend.com"
	defaultTimeoutMS = 30000
)

// Where PARIDAD_DEBUG=1 writes; the tests replace it.
var debugOutput io.Writer = os.Stderr

// Error is the error of a failed operation (vault/CONTRACT.md §5.2); get it with
// errors.As. Code is the `name` of the response body, or http_<status> without
// one; Message is its `message` unchanged. StatusCode is 0 when there was no
// response: invalid_idempotency_key, timeout and connection_error.
type Error struct {
	Code       string
	Message    string
	StatusCode int
}

func (e *Error) Error() string {
	if e.StatusCode == 0 {
		return fmt.Sprintf("resend: %s: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("resend: %s (status %d): %s", e.Code, e.StatusCode, e.Message)
}

// Option configures NewClient.
type Option func(*config)

type config struct {
	apiKey     string
	baseURL    string
	timeout    time.Duration
	timeoutSet bool
}

// WithAPIKey sets the API key. Default: RESEND_API_KEY.
func WithAPIKey(key string) Option {
	return func(c *config) { c.apiKey = key }
}

// WithBaseURL sets the base URL. Default: RESEND_BASE_URL, then https://api.resend.com.
func WithBaseURL(baseURL string) Option {
	return func(c *config) { c.baseURL = baseURL }
}

// WithTimeout sets the maximum time of each attempt. Default: RESEND_TIMEOUT_MS
// milliseconds, then 30 seconds.
func WithTimeout(timeout time.Duration) Option {
	return func(c *config) { c.timeout, c.timeoutSet = timeout, true }
}

// RequestOption configures one call of an operation that accepts Idempotency-Key.
type RequestOption func(*requestOptions)

type requestOptions struct {
	idempotencyKey *string
}

// WithIdempotencyKey sends key as Idempotency-Key, the same on every attempt; it
// must have 1 to 256 characters. The client never makes one up.
func WithIdempotencyKey(key string) RequestOption {
	return func(o *requestOptions) { o.idempotencyKey = &key }
}

// Ptr returns a pointer to value, for the optional fields of the request types.
func Ptr[T any](value T) *T {
	return &value
}

type bodyKind int

const (
	bodyNone bodyKind = iota
	bodyJSON
	bodyMultipart
)

// What a generated method knows about its operation.
type operation struct {
	id     string
	method string
	path   string
	// Names of the query parameters, in the order of the specification.
	query []string
	body  bodyKind
}

// A rule with anyName matches any name; otherwise name nil matches a body without `name`.
type responseRule struct {
	status  int
	anyName bool
	name    *string
}

type retryRules struct {
	responses []responseRule
	transport []string
}

type backoffPolicy struct {
	retryAfterJitterMS   int
	retryAfterMaxSeconds int
	baseMS               int
	capMS                int
}

type idempotencyKeyPolicy struct {
	header       string
	minLength    int
	maxLength    int
	errorCode    string
	errorMessage string
}

// `policy` of the IR (ir/overlay.yaml).
type policy struct {
	maxAttempts            int
	safeMethods            []string
	safeWithIdempotencyKey bool
	retryAlways            retryRules
	retryIfSafe            retryRules
	backoff                backoffPolicy
	idempotencyKey         idempotencyKeyPolicy
}

func ptr(value string) *string {
	return &value
}

const (
	transportTimeout          = "timeout"
	transportBeforeSend       = "connection_error_before_send"
	transportAfterSend        = "connection_error_after_send"
	transportNone             = ""
	invalidResponseCode       = "invalid_response"
	invalidResponseMessage    = "The response body is not valid JSON."
	connectionErrorCode       = "connection_error"
	connectionBeforeSendError = "Could not connect to the API."
	connectionAfterSendError  = "The connection closed before the response was complete."
)

type outcome struct {
	body       []byte
	err        *Error
	status     int
	name       *string
	transport  string
	retryAfter string
}

type core struct {
	apiKey  string
	baseURL string
	// Path of the base URL, prefixed to every operation path.
	prefix  string
	timeout time.Duration
	debug   bool
	http    *http.Client
}

func newCore(options []Option) (*core, error) {
	var cfg config
	for _, option := range options {
		option(&cfg)
	}
	key := cfg.apiKey
	if key == "" {
		key = os.Getenv("RESEND_API_KEY")
	}
	if key == "" {
		return nil, errors.New("resend: missing API key; pass WithAPIKey or set RESEND_API_KEY")
	}
	baseURL := cfg.baseURL
	if baseURL == "" {
		baseURL = os.Getenv("RESEND_BASE_URL")
	}
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("resend: the base URL %s is not an http or https URL", baseURL)
	}
	timeout := cfg.timeout
	if !cfg.timeoutSet {
		timeout = defaultTimeoutMS * time.Millisecond
		if value := strings.TrimSpace(os.Getenv("RESEND_TIMEOUT_MS")); value != "" {
			ms, err := strconv.Atoi(value)
			if err != nil || ms <= 0 {
				return nil, errors.New("resend: the timeout must be a positive integer of milliseconds")
			}
			timeout = time.Duration(ms) * time.Millisecond
		}
	}
	if timeout <= 0 {
		return nil, errors.New("resend: the timeout must be positive")
	}
	// A new connection per attempt: net/http would otherwise replay some failed
	// requests on a reused connection by itself, outside the policy of §5.3.
	var transport *http.Transport
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		transport = base.Clone()
	} else {
		transport = &http.Transport{Proxy: http.ProxyFromEnvironment}
	}
	transport.DisableKeepAlives = true
	c := &core{
		apiKey:  key,
		baseURL: baseURL,
		prefix:  parsed.EscapedPath(),
		timeout: timeout,
		debug:   os.Getenv("PARIDAD_DEBUG") == "1",
		http:    &http.Client{Transport: transport},
	}
	if c.debug {
		debugf("config base_url=%s timeout_ms=%d api_key=%s user_agent=%s", baseURL, timeout.Milliseconds(), maskKey(key), UserAgent)
	}
	return c, nil
}

// request runs op with the retry policy and decodes a success into T. The error
// is *Error, or ctx.Err() when ctx ends first.
func request[T any](ctx context.Context, c *core, op *operation, path []string, query map[string][]string, body any, options []RequestOption) (*T, error) {
	raw, err := c.do(ctx, op, path, query, body, options)
	if err != nil {
		return nil, err
	}
	result := new(T)
	decode(raw, result)
	return result, nil
}

// paginate yields every item of every page, asking for the next page with after =
// id of the last item while has_more is true. Each page follows the retry policy;
// an error that remains is yielded once with a zero item and ends the iteration.
func paginate[T any](ctx context.Context, c *core, op *operation, path []string, query map[string][]string) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		after := ""
		for {
			values := maps.Clone(query)
			if values == nil {
				values = map[string][]string{}
			}
			delete(values, "after")
			if after != "" {
				values["after"] = []string{after}
			}
			raw, err := c.do(ctx, op, path, values, nil, nil)
			if err != nil {
				var zero T
				yield(zero, err)
				return
			}
			var page map[string]json.RawMessage
			var items []json.RawMessage
			var hasMore bool
			_ = json.Unmarshal(raw, &page)
			_ = json.Unmarshal(page["data"], &items)
			_ = json.Unmarshal(page["has_more"], &hasMore)
			for _, rawItem := range items {
				var item T
				decode(rawItem, &item)
				if !yield(item, nil) {
					return
				}
			}
			if !hasMore || len(items) == 0 {
				return
			}
			var last map[string]any
			_ = json.Unmarshal(items[len(items)-1], &last)
			id, ok := last["id"].(string)
			if !ok {
				return
			}
			after = id
		}
	}
}

// decode fills target from valid JSON. As in the TS SDK, types are not checked:
// encoding/json keeps decoding past a value of another type and leaves it zero.
func decode(raw []byte, target any) {
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, target)
	}
}

func (c *core) do(ctx context.Context, op *operation, path []string, query map[string][]string, body any, options []RequestOption) ([]byte, error) {
	var opts requestOptions
	for _, option := range options {
		option(&opts)
	}
	rules := currentPolicy.idempotencyKey
	key := opts.idempotencyKey
	if key != nil {
		if length := utf8.RuneCountInString(*key); length < rules.minLength || length > rules.maxLength {
			return nil, &Error{Code: rules.errorCode, Message: rules.errorMessage}
		}
	}
	target, pathname := c.target(op, path, query)
	header := http.Header{}
	header.Set("Authorization", "Bearer "+c.apiKey)
	header.Set("User-Agent", UserAgent)
	if key != nil {
		header.Set(rules.header, *key)
	}
	// The body is serialized once, so every attempt sends the same bytes.
	var payload []byte
	switch op.body {
	case bodyJSON:
		encoded, err := encodeJSON(body)
		if err != nil {
			return nil, fmt.Errorf("resend: encode the body of %s: %w", op.id, err)
		}
		payload = encoded
		header.Set("Content-Type", "application/json")
	case bodyMultipart:
		encoded, contentType, err := encodeMultipart(body)
		if err != nil {
			return nil, fmt.Errorf("resend: encode the body of %s: %w", op.id, err)
		}
		payload = encoded
		header.Set("Content-Type", contentType)
	}
	safe := slices.Contains(currentPolicy.safeMethods, op.method) || (currentPolicy.safeWithIdempotencyKey && key != nil)

	for attempt := 1; ; attempt++ {
		out := c.attempt(ctx, op.method, target, header, payload)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		wait, retry := 0.0, false
		if attempt < currentPolicy.maxAttempts {
			wait, retry = retryDelay(out, safe, attempt)
		}
		if c.debug {
			result := strconv.Itoa(out.status)
			if out.status == 0 && out.err != nil {
				result = out.err.Code
			}
			next := "none"
			if retry {
				next = strconv.FormatFloat(math.Round(wait), 'f', 0, 64)
			}
			debugf("operation=%s method=%s path=%s attempt=%d result=%s wait_ms=%s", op.id, op.method, pathname, attempt, result, next)
		}
		if !retry {
			if out.err != nil {
				return nil, out.err
			}
			return out.body, nil
		}
		timer := time.NewTimer(time.Duration(wait * float64(time.Millisecond)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

// target is the URL of the request and its path, as encodeURIComponent and
// URLSearchParams write them in the TS SDK.
func (c *core) target(op *operation, path []string, query map[string][]string) (string, string) {
	var b strings.Builder
	template := op.path
	index := 0
	for {
		start := strings.IndexByte(template, '{')
		end := strings.IndexByte(template, '}')
		if start < 0 || end < start {
			b.WriteString(template)
			break
		}
		b.WriteString(template[:start])
		value := ""
		if index < len(path) {
			value = path[index]
		}
		index++
		b.WriteString(escape(value, componentSafe, false))
		template = template[end+1:]
	}
	pathname := c.prefix + b.String()
	var pairs []string
	for _, name := range op.query {
		for _, value := range query[name] {
			pairs = append(pairs, escape(name, formSafe, true)+"="+escape(value, formSafe, true))
		}
	}
	full := c.baseURL + b.String()
	if len(pairs) > 0 {
		full += "?" + strings.Join(pairs, "&")
	}
	return full, pathname
}

func (c *core) attempt(ctx context.Context, method, target string, header http.Header, payload []byte) outcome {
	attemptCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(attemptCtx, method, target, reader)
	if err != nil {
		return c.transport(transportBeforeSend)
	}
	req.Header = header.Clone()
	resp, err := c.http.Do(req)
	if err != nil {
		if attemptCtx.Err() != nil {
			return c.transport(transportTimeout)
		}
		if beforeSend(err) {
			return c.transport(transportBeforeSend)
		}
		return c.transport(transportAfterSend)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		// The connection closed in the middle of the response.
		if attemptCtx.Err() != nil {
			return c.transport(transportTimeout)
		}
		return c.transport(transportAfterSend)
	}
	return fromResponse(resp.StatusCode, resp.Header.Get("Retry-After"), raw)
}

func (c *core) transport(transport string) outcome {
	var err *Error
	switch transport {
	case transportTimeout:
		err = &Error{Code: "timeout", Message: fmt.Sprintf("The request timed out after %d ms.", c.timeout.Milliseconds())}
	case transportBeforeSend:
		err = &Error{Code: connectionErrorCode, Message: connectionBeforeSendError}
	default:
		err = &Error{Code: connectionErrorCode, Message: connectionAfterSendError}
	}
	return outcome{err: err, transport: transport}
}

func fromResponse(status int, retryAfter string, raw []byte) outcome {
	if status >= 200 && status < 300 {
		if len(raw) > 0 && !json.Valid(raw) {
			return outcome{err: &Error{Code: invalidResponseCode, Message: invalidResponseMessage, StatusCode: status}, status: status, retryAfter: retryAfter}
		}
		return outcome{body: raw, status: status, retryAfter: retryAfter}
	}
	var parsed any
	_ = json.Unmarshal(raw, &parsed)
	fields, _ := parsed.(map[string]any)
	var name *string
	if value, ok := fields["name"].(string); ok {
		name = &value
	}
	message, ok := fields["message"].(string)
	if !ok {
		message = fmt.Sprintf("Request failed with status %d.", status)
	}
	code := fmt.Sprintf("http_%d", status)
	if name != nil {
		code = *name
	}
	return outcome{err: &Error{Code: code, Message: message, StatusCode: status}, status: status, name: name, retryAfter: retryAfter}
}

// retryDelay is the wait in milliseconds before the next attempt, and false when
// the outcome is final (§5.3).
func retryDelay(out outcome, safe bool, attempt int) (float64, bool) {
	if out.err == nil {
		return 0, false
	}
	matches := func(rules retryRules) bool {
		if out.transport != transportNone {
			return slices.Contains(rules.transport, out.transport)
		}
		for _, rule := range rules.responses {
			if rule.status != out.status {
				continue
			}
			if rule.anyName || (rule.name == nil && out.name == nil) || (rule.name != nil && out.name != nil && *rule.name == *out.name) {
				return true
			}
		}
		return false
	}
	if !matches(currentPolicy.retryAlways) && !(safe && matches(currentPolicy.retryIfSafe)) {
		return 0, false
	}
	backoff := currentPolicy.backoff
	if retryAfter := strings.TrimSpace(out.retryAfter); retryAfter != "" && strings.Trim(retryAfter, "0123456789") == "" {
		seconds, err := strconv.Atoi(retryAfter)
		if err != nil || seconds > backoff.retryAfterMaxSeconds {
			return 0, false
		}
		return float64(seconds*1000) + rand.Float64()*float64(backoff.retryAfterJitterMS), true
	}
	return min(float64(backoff.capMS), float64(backoff.baseMS)*math.Pow(2, float64(attempt-1))) * (0.5 + 0.5*rand.Float64()), true
}

func beforeSend(err error) bool {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr) && opErr.Op == "dial"
}

func encodeJSON(body any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// encodeMultipart writes each set field of a body struct as a part: []byte as a
// file named like the field, strings as they are, anything else as JSON. Parts go
// sorted by field name with a boundary derived from their data, so the three SDKs
// send the same bytes for the same body.
func encodeMultipart(body any) ([]byte, string, error) {
	type part struct {
		name, head string
		data       []byte
	}
	var parts []part
	value := reflect.ValueOf(body)
	for value.Kind() == reflect.Pointer && !value.IsNil() {
		value = value.Elem()
	}
	if value.Kind() == reflect.Struct {
		for i := range value.NumField() {
			name, _, _ := strings.Cut(value.Type().Field(i).Tag.Get("json"), ",")
			field := value.Field(i)
			if name == "" || name == "-" || isNil(field) {
				continue
			}
			for field.Kind() == reflect.Pointer {
				field = field.Elem()
			}
			quoted := strings.ReplaceAll(name, `"`, "%22")
			head := `Content-Disposition: form-data; name="` + quoted + `"`
			switch data := field.Interface().(type) {
			case []byte:
				parts = append(parts, part{name, head + `; filename="` + quoted + "\"\r\nContent-Type: application/octet-stream", data})
			case string:
				parts = append(parts, part{name, head, []byte(data)})
			default:
				encoded, err := encodeJSON(data)
				if err != nil {
					return nil, "", err
				}
				parts = append(parts, part{name, head, encoded})
			}
		}
	}
	slices.SortFunc(parts, func(a, b part) int { return strings.Compare(a.name, b.name) })
	digest := sha256.New()
	for _, p := range parts {
		digest.Write(p.data)
	}
	boundary := "paridad-" + hex.EncodeToString(digest.Sum(nil)[:16])
	var buf bytes.Buffer
	for _, p := range parts {
		buf.WriteString("--" + boundary + "\r\n" + p.head + "\r\n\r\n")
		buf.Write(p.data)
		buf.WriteString("\r\n")
	}
	buf.WriteString("--" + boundary + "--\r\n")
	return buf.Bytes(), "multipart/form-data; boundary=" + boundary, nil
}

func isNil(value reflect.Value) bool {
	switch value.Kind() {
	case reflect.Pointer, reflect.Slice, reflect.Map, reflect.Interface:
		return value.IsNil()
	}
	return false
}

// A value of a query parameter, as JavaScript's String() writes it.
func queryText(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case int:
		return strconv.Itoa(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return fmt.Sprint(value)
}

// An array query parameter: one value per item when explode, else joined by commas.
func queryList[T any](items []T, explode bool) []string {
	texts := make([]string, len(items))
	for i, item := range items {
		texts[i] = queryText(item)
	}
	if explode {
		return texts
	}
	return []string{strings.Join(texts, ",")}
}

const (
	// Left as they are by encodeURIComponent.
	componentSafe = "-_.!~*'()"
	// Left as they are by URLSearchParams.
	formSafe = "*-._"
)

func escape(value, safe string, spaceAsPlus bool) string {
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		ch := value[i]
		switch {
		case 'a' <= ch && ch <= 'z', 'A' <= ch && ch <= 'Z', '0' <= ch && ch <= '9', strings.IndexByte(safe, ch) >= 0:
			b.WriteByte(ch)
		case ch == ' ' && spaceAsPlus:
			b.WriteByte('+')
		default:
			fmt.Fprintf(&b, "%%%02X", ch)
		}
	}
	return b.String()
}

// maskKey never shows the key: re_... and its last 4 characters.
func maskKey(key string) string {
	if len(key) > 4 {
		return "re_..." + key[len(key)-4:]
	}
	return "re_..."
}

func debugf(format string, args ...any) {
	fmt.Fprintf(debugOutput, "[paridad] "+format+"\n", args...)
}
