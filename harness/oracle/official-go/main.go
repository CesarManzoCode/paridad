// Command official-go runs a neutral case (vault/CONTRACT.md §8) with the official
// Go SDK, github.com/resend/resend-go/v3 v3.17.0 (§7, D08), against RESEND_BASE_URL
// (with its trailing /) with RESEND_API_KEY, and prints one results.jsonl line.
// The method and its arguments come from harness/oracle/official-map.json, with
// the template rules written in harness/oracle/official-map.ts: a first
// context.Context parameter is supplied here, every other argument is decoded
// from JSON into the parameter type, and a key that names a field tagged
// `json:"-"` is set on that field. The public methods of the SDK are listed with
// `go doc -all`, not here. Run from the repository root:
// official-go '<case JSON>' | official-go --plan '<case JSON>'.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"strings"

	resend "github.com/resend/resend-go/v3"
)

type absentValue struct{}

// absent marks a template whose value the case does not have.
var absent = absentValue{}

type neutralCase struct {
	Case           string         `json:"case"`
	Operation      string         `json:"operation"`
	Path           map[string]any `json:"path"`
	Query          map[string]any `json:"query"`
	Body           any            `json:"body"`
	IdempotencyKey *string        `json:"idempotency_key"`
	Iterate        bool           `json:"iterate"`
}

type mapEntry struct {
	Method string `json:"method"`
	Args   []any  `json:"args"`
}

type call struct {
	Method string `json:"method"`
	Args   []any  `json:"args"`
}

type errorLine struct {
	Code       *string `json:"code"`
	Message    string  `json:"message"`
	StatusCode *int    `json:"statusCode"`
}

type resultLine struct {
	Case     string     `json:"case"`
	Surface  string     `json:"surface"`
	Outcome  string     `json:"outcome"`
	Error    *errorLine `json:"error"`
	Items    []any      `json:"items"`
	ExitCode *int       `json:"exit_code"`
}

var contextType = reflect.TypeOf((*context.Context)(nil)).Elem()

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "official go driver: %v\n", err)
		os.Exit(2)
	}
}

func run(argv []string) error {
	plan := len(argv) == 2 && argv[0] == "--plan"
	if len(argv) != 1 && !plan {
		return errors.New("usage: official-go [--plan] '<case JSON>'")
	}
	var c neutralCase
	if err := decodeJSON([]byte(argv[len(argv)-1]), &c); err != nil {
		return fmt.Errorf("case: %w", err)
	}
	if c.Iterate {
		return errors.New("the official SDKs have no iterator; cases with an oracle do not iterate")
	}
	translated, err := officialCall(c)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if plan {
		return encoder.Encode(translated)
	}

	callErr, err := invoke(resend.NewClient(os.Getenv("RESEND_API_KEY")), translated)
	if err != nil {
		return err
	}
	line := resultLine{Case: c.Case, Surface: "official-go", Outcome: "ok"}
	if callErr != nil {
		// resend-go errors carry only a message (a *RateLimitError for 429).
		line.Outcome = "error"
		line.Error = &errorLine{Message: callErr.Error()}
		var rate *resend.RateLimitError
		if errors.As(callErr, &rate) {
			code := "rate_limit_exceeded"
			status := 429
			line.Error.Code, line.Error.StatusCode = &code, &status
		}
	}
	return encoder.Encode(line)
}

func decodeJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	return decoder.Decode(target)
}

func officialCall(c neutralCase) (call, error) {
	raw, err := os.ReadFile("harness/oracle/official-map.json")
	if err != nil {
		return call{}, err
	}
	var officialMap struct {
		Operations map[string]map[string]mapEntry `json:"operations"`
	}
	if err := decodeJSON(raw, &officialMap); err != nil {
		return call{}, fmt.Errorf("official-map.json: %w", err)
	}
	entry, ok := officialMap.Operations[c.Operation]["go"]
	if !ok {
		return call{}, fmt.Errorf("official-map.json has no Go method for %s", c.Operation)
	}
	scope := map[string]any{"path": c.Path, "query": c.Query, "body": c.Body, "idempotency_key": nil}
	if c.IdempotencyKey != nil {
		scope["idempotency_key"] = *c.IdempotencyKey
	}
	out := call{Method: entry.Method, Args: []any{}}
	for _, template := range entry.Args {
		value, err := resolve(template, scope, nil)
		if err != nil {
			return call{}, err
		}
		if value == absent {
			value = nil
		}
		out.Args = append(out.Args, value)
	}
	return out, nil
}

func resolve(template any, scope map[string]any, item any) (any, error) {
	switch t := template.(type) {
	case string:
		if strings.HasPrefix(t, "$") {
			return reference(t, scope, item)
		}
		return t, nil
	case []any:
		list := []any{}
		for _, member := range t {
			value, err := resolve(member, scope, item)
			if err != nil {
				return nil, err
			}
			if value != absent {
				list = append(list, value)
			}
		}
		return list, nil
	case map[string]any:
		if each, ok := t["$each"]; ok {
			values, err := resolve(each, scope, item)
			if err != nil {
				return nil, err
			}
			list, ok := values.([]any)
			if !ok {
				return absent, nil
			}
			out := []any{}
			for _, element := range list {
				value, err := resolve(t["as"], scope, element)
				if err != nil {
					return nil, err
				}
				out = append(out, value)
			}
			return out, nil
		}
		result := map[string]any{}
		for key, value := range t {
			if key == "$with" || key == "$camel" {
				base, err := resolve(value, scope, item)
				if err != nil {
					return nil, err
				}
				if object, ok := base.(map[string]any); ok {
					for baseKey, baseValue := range object {
						if key == "$camel" {
							baseKey = camel(baseKey)
						}
						result[baseKey] = baseValue
					}
				}
			}
		}
		for key, value := range t {
			if key == "$with" || key == "$camel" {
				continue
			}
			resolved, err := resolve(value, scope, item)
			if err != nil {
				return nil, err
			}
			if resolved != absent {
				result[key] = resolved
			}
		}
		return result, nil
	default:
		return template, nil
	}
}

func reference(text string, scope map[string]any, item any) (any, error) {
	root, name, hasName := strings.Cut(text[1:], ".")
	if root == "item" {
		scope = map[string]any{"item": item}
	}
	value, ok := scope[root]
	if !ok {
		return nil, fmt.Errorf("unknown template reference %s", text)
	}
	if hasName {
		object, isObject := value.(map[string]any)
		if !isObject {
			return absent, nil
		}
		value = object[name]
	}
	if value == nil {
		return absent, nil
	}
	return value, nil
}

var underscore = regexp.MustCompile(`_([a-z0-9])`)

func camel(key string) string {
	return underscore.ReplaceAllStringFunc(key, func(match string) string { return strings.ToUpper(match[1:]) })
}

// invoke calls the method named by c.Method on the client; it returns the error
// that the SDK method returned, and an error of its own if the call could not be made.
func invoke(client *resend.Client, c call) (error, error) {
	segments := strings.Split(c.Method, ".")
	owner := reflect.ValueOf(client)
	for _, segment := range segments[:len(segments)-1] {
		owner = concrete(owner).FieldByName(segment)
		if !owner.IsValid() {
			return nil, fmt.Errorf("the Go SDK has no service %s in %s", segment, c.Method)
		}
	}
	if owner.Kind() == reflect.Interface {
		owner = owner.Elem()
	}
	method := owner.MethodByName(segments[len(segments)-1])
	if !method.IsValid() {
		return nil, fmt.Errorf("the Go SDK has no method %s", c.Method)
	}
	kind := method.Type()
	in := []reflect.Value{}
	if kind.NumIn() > 0 && kind.In(0) == contextType {
		in = append(in, reflect.ValueOf(context.Background()))
	}
	offset := len(in)
	if len(c.Args) > kind.NumIn()-offset {
		return nil, fmt.Errorf("%s takes %d arguments besides the context, the map gives %d", c.Method, kind.NumIn()-offset, len(c.Args))
	}
	for index := offset; index < kind.NumIn(); index++ {
		var arg any
		if position := index - offset; position < len(c.Args) {
			arg = c.Args[position]
		}
		value, err := argument(kind.In(index), arg)
		if err != nil {
			return nil, fmt.Errorf("%s argument %d: %w", c.Method, index, err)
		}
		in = append(in, value)
	}
	out := method.Call(in)
	if last := out[len(out)-1]; !last.IsNil() {
		return last.Interface().(error), nil
	}
	return nil, nil
}

func concrete(value reflect.Value) reflect.Value {
	for value.Kind() == reflect.Pointer || value.Kind() == reflect.Interface {
		value = value.Elem()
	}
	return value
}

// argument decodes a resolved template into a value of type t; nil is the zero value.
func argument(t reflect.Type, arg any) (reflect.Value, error) {
	if arg == nil {
		return reflect.Zero(t), nil
	}
	base := t
	if t.Kind() == reflect.Pointer {
		base = t.Elem()
	}
	value := reflect.New(base)
	raw, err := json.Marshal(arg)
	if err != nil {
		return reflect.Value{}, err
	}
	if err := json.Unmarshal(raw, value.Interface()); err != nil {
		return reflect.Value{}, fmt.Errorf("decoding %s: %w", base, err)
	}
	if object, ok := arg.(map[string]any); ok && base.Kind() == reflect.Struct {
		for key, fieldValue := range object {
			field, found := base.FieldByName(key)
			if !found || !field.IsExported() || field.Tag.Get("json") != "-" {
				continue
			}
			fieldRaw, err := json.Marshal(fieldValue)
			if err != nil {
				return reflect.Value{}, err
			}
			if err := json.Unmarshal(fieldRaw, value.Elem().FieldByIndex(field.Index).Addr().Interface()); err != nil {
				return reflect.Value{}, fmt.Errorf("decoding %s.%s: %w", base, key, err)
			}
		}
	}
	if t.Kind() == reflect.Pointer {
		return value, nil
	}
	return value.Elem(), nil
}
