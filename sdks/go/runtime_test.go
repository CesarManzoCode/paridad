// Runtime of the paridad Go SDK against an httptest server: authentication,
// User-Agent, error mapping, the retry table of vault/CONTRACT.md §5.3, idempotency,
// pagination and the absence of the API key in errors and debug output.

package resend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const testKey = "re_paridad_test_9f8e7d6c5b4a39281706"

const sendJSON = `{"from":"Acme <onboarding@resend.dev>","to":["delivered@resend.dev"],"subject":"Hello World","html":"<p>It works!</p>"}`

const idempotencyMessage = "Idempotency key must be between 1 and 256 characters."

// mustDecode decodes JSON text into target, or panics.
func mustDecode(text string, target any) {
	if err := json.Unmarshal([]byte(text), target); err != nil {
		panic(err)
	}
}

func sendBody() *SendEmailRequest {
	var body SendEmailRequest
	mustDecode(sendJSON, &body)
	return &body
}

type receivedRequest struct {
	method string
	url    string
	header http.Header
	body   []byte
}

// Answers request n with handlers[n], or the last handler once they run out.
type handler func(w http.ResponseWriter, r *http.Request)

type testServer struct {
	url      string
	server   *httptest.Server
	mu       sync.Mutex
	received []receivedRequest
}

func serve(t *testing.T, handlers ...handler) *testServer {
	t.Helper()
	s := &testServer{}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		h := handlers[min(len(s.received), len(handlers)-1)]
		s.received = append(s.received, receivedRequest{r.Method, r.RequestURI, r.Header.Clone(), body})
		s.mu.Unlock()
		h(w, r)
	}))
	s.url = s.server.URL
	t.Cleanup(s.server.Close)
	return s
}

func (s *testServer) requests() []receivedRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.received)
}

func jsonHandler(status int, body string, headers map[string]string) handler {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		for name, value := range headers {
			w.Header().Set(name, value)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

var (
	ok   = jsonHandler(200, `{"id":"49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"}`, nil)
	list = jsonHandler(200, `{"object":"list","has_more":false,"data":[]}`, nil)
)

func apiError(status int, name, message string, headers map[string]string) handler {
	body, _ := json.Marshal(map[string]any{"statusCode": status, "name": name, "message": message})
	return jsonHandler(status, string(body), headers)
}

// Never answers within the client timeout used below.
func hang(w http.ResponseWriter, r *http.Request) {
	select {
	case <-time.After(2 * time.Second):
		ok(w, r)
	case <-r.Context().Done():
	}
}

// Sends the headers and part of the body, then closes the connection.
func cut(w http.ResponseWriter, r *http.Request) {
	conn, buf, err := w.(http.Hijacker).Hijack()
	if err != nil {
		panic(err)
	}
	_, _ = buf.WriteString("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{\"object\":\"li")
	_ = buf.Flush()
	_ = conn.Close()
}

func newTestClient(t *testing.T, s *testServer, timeout time.Duration) *Client {
	t.Helper()
	client, err := NewClient(WithAPIKey(testKey), WithBaseURL(s.url), WithTimeout(timeout))
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func client(t *testing.T, s *testServer) *Client {
	return newTestClient(t, s, 300*time.Millisecond)
}

func asError(t *testing.T, err error) *Error {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("error %v is not *resend.Error", err)
	}
	return e
}

func expectCode(t *testing.T, err error, code string, status int) {
	t.Helper()
	e := asError(t, err)
	if e.Code != code || e.StatusCode != status {
		t.Fatalf("error %s %d, want %s %d", e.Code, e.StatusCode, code, status)
	}
}

func expectRequests(t *testing.T, s *testServer, n int) {
	t.Helper()
	if got := len(s.requests()); got != n {
		t.Fatalf("%d requests, want %d", got, n)
	}
}

func noError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error %v", err)
	}
}

// withDebug turns PARIDAD_DEBUG on and returns the buffer the debug lines go to;
// build the client after calling it.
func withDebug(t *testing.T) *bytes.Buffer {
	t.Setenv("PARIDAD_DEBUG", "1")
	var buf bytes.Buffer
	saved := debugOutput
	debugOutput = &buf
	t.Cleanup(func() { debugOutput = saved })
	return &buf
}

func sameKeyAndBody(t *testing.T, s *testServer, key string) {
	t.Helper()
	requests := s.requests()
	for _, r := range requests {
		if r.header.Get("Idempotency-Key") != key {
			t.Fatalf("Idempotency-Key %q, want %q", r.header.Get("Idempotency-Key"), key)
		}
		if !bytes.Equal(r.body, requests[0].body) {
			t.Fatalf("body %q differs from the first %q", r.body, requests[0].body)
		}
	}
}

func idOf(item any) string {
	raw, _ := json.Marshal(item)
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	id, _ := fields["id"].(string)
	return id
}

func TestEveryRequestCarriesAuthorizationAndUserAgent(t *testing.T) {
	s := serve(t, list, ok)
	c := client(t, s)
	ctx := context.Background()
	_, err := c.Domains.List(ctx, nil)
	noError(t, err)
	_, err = c.Emails.Send(ctx, sendBody())
	noError(t, err)
	if UserAgent != "paridad-go/"+Version {
		t.Fatalf("User-Agent %s", UserAgent)
	}
	requests := s.requests()
	for _, r := range requests {
		if r.header.Get("Authorization") != "Bearer "+testKey {
			t.Fatalf("Authorization %q", r.header.Get("Authorization"))
		}
		if r.header.Get("User-Agent") != UserAgent {
			t.Fatalf("User-Agent %q", r.header.Get("User-Agent"))
		}
	}
	get, post := requests[0], requests[1]
	if get.method != "GET" || get.url != "/domains" || get.header.Get("Content-Type") != "" {
		t.Fatalf("GET request %s %s with Content-Type %q", get.method, get.url, get.header.Get("Content-Type"))
	}
	if post.method != "POST" || post.url != "/emails" || post.header.Get("Content-Type") != "application/json" {
		t.Fatalf("POST request %s %s with Content-Type %q", post.method, post.url, post.header.Get("Content-Type"))
	}
	var sent, want any
	mustDecode(string(post.body), &sent)
	mustDecode(sendJSON, &want)
	if !reflect.DeepEqual(sent, want) {
		t.Fatalf("body %s, want %s", post.body, sendJSON)
	}
}

func TestHeaderParametersOtherThanIdempotencyKeyAreSent(t *testing.T) {
	s := serve(t, list, ok)
	c := client(t, s)
	_, err := request[json.RawMessage](context.Background(), c.Domains.core, opDomainsList, nil, nil, nil, []RequestOption{withHeaders(map[string][]string{"X-Trace": {"t-1"}})})
	noError(t, err)
	if got := s.requests()[0].header.Get("X-Trace"); got != "t-1" {
		t.Fatalf("X-Trace %q", got)
	}
}

func TestConfigurationFromEnvironment(t *testing.T) {
	s := serve(t, hang, list)
	t.Setenv("RESEND_API_KEY", testKey)
	t.Setenv("RESEND_BASE_URL", s.url+"/")
	t.Setenv("RESEND_TIMEOUT_MS", "200")
	c, err := NewClient()
	noError(t, err)
	started := time.Now()
	_, err = c.Domains.List(context.Background(), nil)
	noError(t, err)
	// The first attempt timed out after 200 ms instead of the 30000 ms default.
	if elapsed := time.Since(started); elapsed >= 1900*time.Millisecond {
		t.Fatalf("took %s", elapsed)
	}
	requests := s.requests()
	if len(requests) != 2 || requests[0].url != "/domains" || requests[0].header.Get("Authorization") != "Bearer "+testKey {
		t.Fatalf("requests %+v", requests)
	}
}

func TestWithoutKeyTheClientDoesNotStart(t *testing.T) {
	t.Setenv("RESEND_API_KEY", "")
	if _, err := NewClient(); err == nil || !strings.Contains(err.Error(), "missing API key") {
		t.Fatalf("error %v", err)
	}
}

func TestNon2xxBecomesError(t *testing.T) {
	s := serve(t, apiError(404, "not_found", "Domain not found", nil), jsonHandler(418, `{"message":"No name"}`, nil), jsonHandler(400, `"plain"`, nil))
	c := client(t, s)
	ctx := context.Background()
	domain, err := c.Domains.Get(ctx, "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794")
	if domain != nil {
		t.Fatalf("data %+v with an error", domain)
	}
	e := asError(t, fmt.Errorf("wrapped: %w", err))
	if e.Code != "not_found" || e.Message != "Domain not found" || e.StatusCode != 404 {
		t.Fatalf("error %+v", e)
	}
	_, err = c.Domains.List(ctx, nil)
	e = asError(t, err)
	if e.Code != "http_418" || e.Message != "No name" || e.StatusCode != 418 {
		t.Fatalf("error %+v", e)
	}
	_, err = c.Domains.List(ctx, nil)
	expectCode(t, err, "http_400", 400)
	expectRequests(t, s, 3)
}

func TestRateLimitWaitsRetryAfter(t *testing.T) {
	s := serve(t, apiError(429, "rate_limit_exceeded", "Too many requests", map[string]string{"Retry-After": "1"}), list)
	started := time.Now()
	_, err := client(t, s).Domains.List(context.Background(), nil)
	elapsed := time.Since(started)
	noError(t, err)
	expectRequests(t, s, 2)
	if elapsed < 975*time.Millisecond || elapsed >= 2000*time.Millisecond {
		t.Fatalf("waited %s", elapsed)
	}
}

func TestRateLimitIsRetriedOnPostWithoutKeyAndStopsAfterThreeAttempts(t *testing.T) {
	limited := apiError(429, "rate_limit_exceeded", "Too many requests", map[string]string{"Retry-After": "0"})
	once := serve(t, limited, ok)
	_, err := client(t, once).Emails.Send(context.Background(), sendBody())
	noError(t, err)
	expectRequests(t, once, 2)
	always := serve(t, limited)
	_, err = client(t, always).Domains.List(context.Background(), nil)
	expectCode(t, err, "rate_limit_exceeded", 429)
	expectRequests(t, always, 3)
}

func TestRetryAfterAboveSixtySecondsIsNotRetried(t *testing.T) {
	s := serve(t, apiError(429, "rate_limit_exceeded", "Too many requests", map[string]string{"Retry-After": "61"}), list)
	_, err := client(t, s).Domains.List(context.Background(), nil)
	expectCode(t, err, "rate_limit_exceeded", 429)
	expectRequests(t, s, 1)
}

func TestQuotaErrorsAreNeverRetried(t *testing.T) {
	for _, name := range []string{"daily_quota_exceeded", "monthly_quota_exceeded"} {
		s := serve(t, apiError(429, name, "Quota exceeded", map[string]string{"Retry-After": "1"}), list)
		_, err := client(t, s).Domains.List(context.Background(), nil)
		expectCode(t, err, name, 429)
		expectRequests(t, s, 1)
	}
}

func Test503IsRetriedOnlyWhenSafe(t *testing.T) {
	unavailable := apiError(503, "service_unavailable", "Service unavailable", nil)
	ctx := context.Background()
	get := serve(t, unavailable, list)
	_, err := client(t, get).Domains.List(ctx, nil)
	noError(t, err)
	expectRequests(t, get, 2)

	withKey := serve(t, unavailable, ok)
	_, err = client(t, withKey).Emails.Send(ctx, sendBody(), WithIdempotencyKey("welcome-user-123"))
	noError(t, err)
	expectRequests(t, withKey, 2)
	sameKeyAndBody(t, withKey, "welcome-user-123")

	withoutKey := serve(t, unavailable, ok)
	_, err = client(t, withoutKey).Emails.Send(ctx, sendBody())
	expectCode(t, err, "service_unavailable", 503)
	expectRequests(t, withoutKey, 1)
}

func Test500OnEveryAttemptGivesApplicationErrorAfterThreeAttempts(t *testing.T) {
	s := serve(t, apiError(500, "application_error", "Internal server error", nil))
	_, err := client(t, s).Domains.List(context.Background(), nil)
	expectCode(t, err, "application_error", 500)
	expectRequests(t, s, 3)
}

func TestConcurrentIdempotentRequestIsRetriedWithKeyAndOther4xxAreNot(t *testing.T) {
	ctx := context.Background()
	concurrent := serve(t, apiError(409, "concurrent_idempotent_requests", "Concurrent request", nil), ok)
	_, err := client(t, concurrent).Emails.Send(ctx, sendBody(), WithIdempotencyKey("k-409"))
	noError(t, err)
	expectRequests(t, concurrent, 2)
	for _, tc := range []struct {
		status int
		name   string
	}{{400, "validation_error"}, {401, "missing_api_key"}, {403, "restricted_api_key"}, {404, "not_found"}, {405, "method_not_allowed"}, {409, "invalid_idempotent_request"}, {422, "missing_required_field"}} {
		s := serve(t, apiError(tc.status, tc.name, "No", nil), ok)
		_, err := client(t, s).Emails.Send(ctx, sendBody(), WithIdempotencyKey("k"))
		expectCode(t, err, tc.name, tc.status)
		expectRequests(t, s, 1)
	}
}

func TestTimeoutIsRetriedOnlyWhenSafe(t *testing.T) {
	ctx := context.Background()
	get := serve(t, hang, list)
	_, err := client(t, get).Domains.List(ctx, nil)
	noError(t, err)
	expectRequests(t, get, 2)

	withKey := serve(t, hang, ok)
	_, err = client(t, withKey).Emails.Send(ctx, sendBody(), WithIdempotencyKey("timeout-key"))
	noError(t, err)
	expectRequests(t, withKey, 2)
	sameKeyAndBody(t, withKey, "timeout-key")

	withoutKey := serve(t, hang, ok)
	_, err = client(t, withoutKey).Emails.Send(ctx, sendBody())
	expectCode(t, err, "timeout", 0)
	expectRequests(t, withoutKey, 1)
}

func TestCutResponseIsRetriedOnlyWhenSafe(t *testing.T) {
	ctx := context.Background()
	get := serve(t, cut, list)
	_, err := client(t, get).Domains.List(ctx, nil)
	noError(t, err)
	expectRequests(t, get, 2)

	withKey := serve(t, cut, ok)
	_, err = client(t, withKey).Emails.Send(ctx, sendBody(), WithIdempotencyKey("cut-key"))
	noError(t, err)
	expectRequests(t, withKey, 2)
	sameKeyAndBody(t, withKey, "cut-key")

	withoutKey := serve(t, cut, ok)
	_, err = client(t, withoutKey).Emails.Send(ctx, sendBody())
	expectCode(t, err, "connection_error", 0)
	expectRequests(t, withoutKey, 1)
}

func TestRefusedConnectionIsRetriedEvenOnPostWithoutKey(t *testing.T) {
	s := serve(t, ok)
	s.server.Close()
	output := withDebug(t)
	_, err := newTestClient(t, s, 300*time.Millisecond).Emails.Send(context.Background(), sendBody())
	expectCode(t, err, "connection_error", 0)
	if n := strings.Count(output.String(), "operation=emails/send"); n != 3 {
		t.Fatalf("%d attempts, want 3:\n%s", n, output)
	}
}

func TestInvalidIdempotencyKeySendsNoRequest(t *testing.T) {
	s := serve(t, ok)
	c := client(t, s)
	ctx := context.Background()
	for _, key := range []string{"", strings.Repeat("k", 257)} {
		data, err := c.Emails.Send(ctx, sendBody(), WithIdempotencyKey(key))
		if data != nil {
			t.Fatalf("data %+v with an error", data)
		}
		e := asError(t, err)
		if e.Code != "invalid_idempotency_key" || e.Message != idempotencyMessage || e.StatusCode != 0 {
			t.Fatalf("error %+v", e)
		}
	}
	expectRequests(t, s, 0)
	_, err := c.Emails.Send(ctx, sendBody(), WithIdempotencyKey(strings.Repeat("k", 256)))
	noError(t, err)
	if got := s.requests()[0].header.Get("Idempotency-Key"); got != strings.Repeat("k", 256) {
		t.Fatalf("Idempotency-Key %q", got)
	}
}

func TestListAllFollowsAfterWhileHasMore(t *testing.T) {
	ids := []string{"c1", "c2", "c3", "c4", "c5"}
	pages := func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		start := 0
		if query.Has("after") {
			start = slices.Index(ids, query.Get("after")) + 1
		}
		limit, _ := strconv.Atoi(query.Get("limit"))
		end := min(start+limit, len(ids))
		data := []map[string]string{}
		for _, id := range ids[start:end] {
			data = append(data, map[string]string{"id": id, "email": id + "@example.com"})
		}
		body, _ := json.Marshal(map[string]any{"object": "list", "has_more": end < len(ids), "data": data})
		jsonHandler(200, string(body), nil)(w, r)
	}
	collect := func(s *testServer) []string {
		var seen []string
		for contact, err := range client(t, s).Contacts.ListAll(context.Background(), &ContactsListAllQuery{Limit: Ptr(2)}) {
			noError(t, err)
			seen = append(seen, idOf(contact))
		}
		return seen
	}
	s := serve(t, pages)
	if seen := collect(s); !slices.Equal(seen, ids) {
		t.Fatalf("items %v", seen)
	}
	var urls []string
	for _, r := range s.requests() {
		urls = append(urls, r.url)
	}
	if want := []string{"/contacts?limit=2", "/contacts?limit=2&after=c2", "/contacts?limit=2&after=c4"}; !slices.Equal(urls, want) {
		t.Fatalf("requests %v, want %v", urls, want)
	}

	// The first request of page 2 is cut: that page is retried (GET), no item repeats.
	flaky := serve(t, pages, cut, pages)
	if seen := collect(flaky); !slices.Equal(seen, ids) {
		t.Fatalf("items %v", seen)
	}
	expectRequests(t, flaky, 4)
}

func TestListAllYieldsTheErrorOfAPageThatKeepsFailing(t *testing.T) {
	s := serve(t, apiError(404, "not_found", "Gone", nil))
	var errs []error
	for item, err := range client(t, s).Contacts.ListAll(context.Background(), nil) {
		if err == nil {
			t.Fatalf("unexpected item %+v", item)
		}
		errs = append(errs, err)
	}
	if len(errs) != 1 {
		t.Fatalf("%d errors, want 1", len(errs))
	}
	expectCode(t, errs[0], "not_found", 404)
}

func TestCanceledContextEndsTheCall(t *testing.T) {
	s := serve(t, hang)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := newTestClient(t, s, time.Second).Domains.List(ctx, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("error %v, want context.Canceled", err)
	}
}

func TestKeyNeverAppearsInErrorsOrDebugOutput(t *testing.T) {
	s := serve(t, apiError(401, "missing_api_key", "Missing API key", nil), hang, cut, apiError(503, "service_unavailable", "Down", nil))
	output := withDebug(t)
	c := client(t, s)
	ctx := context.Background()
	var messages []string
	for range 4 {
		_, err := c.Emails.Send(ctx, sendBody())
		messages = append(messages, fmt.Sprintf("%v %+v %#v", err, err, asError(t, err)))
	}
	_, err := c.Emails.Send(ctx, sendBody(), WithIdempotencyKey(""))
	messages = append(messages, fmt.Sprintf("%v %#v", err, asError(t, err)))
	for _, message := range messages {
		if strings.Contains(message, testKey) {
			t.Fatalf("the key is in %q", message)
		}
	}
	text := output.String()
	if strings.Contains(text, testKey) || strings.Contains(text, testKey[3:len(testKey)-4]) {
		t.Fatalf("the key is in the debug output:\n%s", text)
	}
	for _, pattern := range []string{
		`config .*api_key=re_\.\.\.1706`,
		`operation=emails/send method=POST path=/emails attempt=1 result=401 wait_ms=none`,
		`attempt=1 result=timeout wait_ms=none`,
		`attempt=1 result=connection_error wait_ms=none`,
	} {
		if !regexp.MustCompile(pattern).MatchString(text) {
			t.Fatalf("debug output does not match %s:\n%s", pattern, text)
		}
	}
}

func TestDebugOutputListsEveryAttemptWithTheWait(t *testing.T) {
	s := serve(t, apiError(503, "service_unavailable", "Down", nil), list)
	output := withDebug(t)
	_, err := client(t, s).Domains.List(context.Background(), nil)
	noError(t, err)
	var lines []string
	for _, line := range strings.Split(output.String(), "\n") {
		if strings.Contains(line, "operation=domains/list") {
			lines = append(lines, line)
		}
	}
	if len(lines) != 2 || !regexp.MustCompile(`attempt=1 result=503 wait_ms=\d+$`).MatchString(lines[0]) || !regexp.MustCompile(`attempt=2 result=200 wait_ms=none$`).MatchString(lines[1]) {
		t.Fatalf("debug lines %q", lines)
	}
}
