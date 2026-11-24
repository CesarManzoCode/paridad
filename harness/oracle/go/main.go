// Command driver runs a neutral case (vault/CONTRACT.md §8) with the own Go SDK
// against RESEND_BASE_URL with RESEND_API_KEY, and prints one results.jsonl line.
// The method is found by reflect from names.go of the IR (Service.Method); its
// arguments follow the emitter order: context, path parameters, body, query and
// request options. Run from the repository root: driver '<case JSON>'.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"

	resend "github.com/CesarManzoCode/paridad/sdks/go"
)

type parameter struct {
	Name string `json:"name"`
}

type operation struct {
	ID          string          `json:"id"`
	PathParams  []parameter     `json:"pathParams"`
	QueryParams []parameter     `json:"queryParams"`
	RequestBody json.RawMessage `json:"requestBody"`
	Idempotency bool            `json:"idempotency"`
	Pagination  *struct{}       `json:"pagination"`
	Names       struct {
		Go string `json:"go"`
	} `json:"names"`
}

type neutralCase struct {
	Case           string          `json:"case"`
	Operation      string          `json:"operation"`
	Path           map[string]any  `json:"path"`
	Query          json.RawMessage `json:"query"`
	Body           json.RawMessage `json:"body"`
	IdempotencyKey *string         `json:"idempotency_key"`
	Iterate        bool            `json:"iterate"`
}

type errorLine struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	StatusCode *int   `json:"statusCode"`
}

type resultLine struct {
	Case     string     `json:"case"`
	Surface  string     `json:"surface"`
	Outcome  string     `json:"outcome"`
	Error    *errorLine `json:"error"`
	Items    []any      `json:"items"`
	ExitCode *int       `json:"exit_code"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "go driver: %v\n", err)
		os.Exit(2)
	}
}

func run() error {
	if len(os.Args) != 2 {
		return errors.New("usage: driver '<case JSON>'")
	}
	var c neutralCase
	if err := json.Unmarshal([]byte(os.Args[1]), &c); err != nil {
		return fmt.Errorf("case: %w", err)
	}
	raw, err := os.ReadFile("ir/ir.json")
	if err != nil {
		return err
	}
	var ir struct {
		Operations []operation `json:"operations"`
	}
	if err := json.Unmarshal(raw, &ir); err != nil {
		return fmt.Errorf("ir: %w", err)
	}
	var op *operation
	for index := range ir.Operations {
		if ir.Operations[index].ID == c.Operation {
			op = &ir.Operations[index]
		}
	}
	if op == nil {
		return fmt.Errorf("unknown operation %s", c.Operation)
	}

	client, err := resend.NewClient()
	if err != nil {
		return err
	}
	serviceName, methodName, _ := strings.Cut(op.Names.Go, ".")
	service := reflect.ValueOf(client).Elem().FieldByName(serviceName)
	if !service.IsValid() {
		return fmt.Errorf("no service %s for %s", serviceName, op.ID)
	}
	args := []reflect.Value{reflect.ValueOf(context.Background())}
	for _, p := range op.PathParams {
		value, ok := c.Path[p.Name].(string)
		if !ok {
			value = fmt.Sprint(c.Path[p.Name])
		}
		args = append(args, reflect.ValueOf(value))
	}

	line := resultLine{Case: c.Case, Surface: "go"}
	var callErr error
	if c.Iterate {
		if op.Pagination == nil {
			return fmt.Errorf("%s does not paginate", op.ID)
		}
		method := service.MethodByName(methodName + "All")
		if !method.IsValid() {
			return fmt.Errorf("no method %sAll for %s", op.Names.Go, op.ID)
		}
		if method.Type().NumIn() > len(args) {
			query, err := decode(method.Type().In(len(args)), c.Query)
			if err != nil {
				return err
			}
			args = append(args, query)
		}
		seq := method.Call(args)[0]
		line.Items = []any{}
		yield := reflect.MakeFunc(seq.Type().In(0), func(in []reflect.Value) []reflect.Value {
			if !in[1].IsNil() {
				callErr = in[1].Interface().(error)
				return []reflect.Value{reflect.ValueOf(false)}
			}
			line.Items = append(line.Items, in[0].Interface())
			return []reflect.Value{reflect.ValueOf(true)}
		})
		seq.Call([]reflect.Value{yield})
	} else {
		method := service.MethodByName(methodName)
		if !method.IsValid() {
			return fmt.Errorf("no method %s for %s", op.Names.Go, op.ID)
		}
		kind := method.Type()
		if len(op.RequestBody) > 0 && string(op.RequestBody) != "null" {
			body, err := decode(kind.In(len(args)), c.Body)
			if err != nil {
				return err
			}
			args = append(args, body)
		}
		if len(op.QueryParams) > 0 {
			query, err := decode(kind.In(len(args)), c.Query)
			if err != nil {
				return err
			}
			args = append(args, query)
		}
		var out []reflect.Value
		if kind.IsVariadic() {
			options := []resend.RequestOption{}
			if op.Idempotency && c.IdempotencyKey != nil {
				options = append(options, resend.WithIdempotencyKey(*c.IdempotencyKey))
			}
			out = method.CallSlice(append(args, reflect.ValueOf(options)))
		} else {
			out = method.Call(args)
		}
		if last := out[len(out)-1]; !last.IsNil() {
			callErr = last.Interface().(error)
		}
	}

	line.Outcome = "ok"
	if callErr != nil {
		var apiErr *resend.Error
		if !errors.As(callErr, &apiErr) {
			return fmt.Errorf("unexpected error: %w", callErr)
		}
		line.Outcome = "error"
		line.Error = &errorLine{Code: apiErr.Code, Message: apiErr.Message}
		if apiErr.StatusCode != 0 {
			status := apiErr.StatusCode
			line.Error.StatusCode = &status
		}
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(line)
}

// decode builds an argument of type t from the JSON of the case.
func decode(t reflect.Type, raw json.RawMessage) (reflect.Value, error) {
	target := t
	if t.Kind() == reflect.Pointer {
		target = t.Elem()
	}
	value := reflect.New(target)
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(bytesAsText(target, raw), value.Interface()); err != nil {
			return reflect.Value{}, fmt.Errorf("decoding %s: %w", target, err)
		}
	}
	if t.Kind() == reflect.Pointer {
		return value, nil
	}
	return value.Elem(), nil
}

// bytesAsText rewrites the []byte fields of a struct (multipart files) from the
// text a case gives to the base64 that encoding/json expects, so the file holds
// the same bytes that the TypeScript and Python SDKs send for that text.
func bytesAsText(target reflect.Type, raw json.RawMessage) json.RawMessage {
	if target.Kind() != reflect.Struct {
		return raw
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return raw
	}
	changed := false
	for index := 0; index < target.NumField(); index++ {
		field := target.Field(index)
		if field.Type.Kind() != reflect.Slice || field.Type.Elem().Kind() != reflect.Uint8 {
			continue
		}
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		var text string
		if value, ok := fields[name]; !ok || json.Unmarshal(value, &text) != nil {
			continue
		}
		encoded, _ := json.Marshal(base64.StdEncoding.EncodeToString([]byte(text)))
		fields[name] = encoded
		changed = true
	}
	if !changed {
		return raw
	}
	out, err := json.Marshal(fields)
	if err != nil {
		return raw
	}
	return out
}
