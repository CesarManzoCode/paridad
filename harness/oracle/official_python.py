# .venv/bin/python -I harness/oracle/official_python.py '<case JSON>' | --plan '<case JSON>' | --methods
# Driver of the official Python SDK, PyPI resend==2.55.0 (contract §7, D08): runs a
# neutral case (§8) with the method and arguments that official-map.json gives,
# against RESEND_API_URL with RESEND_API_KEY, and prints one results.jsonl line.
# The templates follow the rules written in official-map.ts. --plan prints the
# translated call {method, args} without running it; --methods prints every public
# method of the SDK, found by introspection of the classes the package exports.
# Run from the repository root.
from __future__ import annotations

import inspect
import json
import re
import sys
from pathlib import Path
from typing import Any

import resend

ROOT = Path(__file__).resolve().parents[2]
ABSENT = object()


def resolve(template: Any, case: dict[str, Any], item: Any) -> Any:
    if isinstance(template, str):
        return reference(template, case, item) if template.startswith("$") else template
    if isinstance(template, list):
        return [value for value in (resolve(member, case, item) for member in template) if value is not ABSENT]
    if not isinstance(template, dict):
        return template
    if "$each" in template:
        values = resolve(template["$each"], case, item)
        return [resolve(template["as"], case, element) for element in values] if isinstance(values, list) else ABSENT
    result: dict[str, Any] = {}
    for key, value in template.items():
        if key in ("$with", "$camel"):
            base = resolve(value, case, item)
            if isinstance(base, dict):
                for base_key, base_value in base.items():
                    result[camel(base_key) if key == "$camel" else base_key] = base_value
            continue
        resolved = resolve(value, case, item)
        if resolved is not ABSENT:
            result[key] = resolved
    return result


def reference(text: str, case: dict[str, Any], item: Any) -> Any:
    root, _, name = text[1:].partition(".")
    scope = {"path": case["path"], "query": case["query"], "body": case["body"], "idempotency_key": case["idempotency_key"], "item": item}
    if root not in scope:
        raise SystemExit(f"official python driver: unknown template reference {text}")
    value = scope[root]
    if name:
        value = value.get(name) if isinstance(value, dict) else None
    return ABSENT if value is None else value


def camel(key: str) -> str:
    return re.sub(r"_([a-z0-9])", lambda match: match.group(1).upper(), key)


def official_call(case: dict[str, Any]) -> dict[str, Any] | None:
    official_map = json.loads((ROOT / "harness" / "oracle" / "official-map.json").read_text(encoding="utf-8"))
    entry = official_map["operations"].get(case["operation"], {}).get("python")
    if entry is None:
        return None
    args = [resolve(template, case, None) for template in entry["args"]]
    return {"method": entry["method"], "args": [None if arg is ABSENT else arg for arg in args]}


def has_class_methods(value: Any) -> bool:
    return any(isinstance(member, (staticmethod, classmethod)) for member in vars(value).values())


def public_methods() -> list[str]:
    # Each class is listed once, under the first exported name (in sorted order)
    # that reaches it; nested resource classes are walked as attributes.
    found: list[str] = []
    seen: set[type] = set()

    def walk(cls: type, prefix: str) -> None:
        for name, member in sorted(vars(cls).items()):
            if name.startswith("_"):
                continue
            if isinstance(member, (staticmethod, classmethod)):
                found.append(f"{prefix}{name}")
            elif inspect.isclass(member) and member.__module__.startswith("resend") and member not in seen and has_class_methods(member):
                seen.add(member)
                walk(member, f"{prefix}{name}.")

    for name in sorted(dir(resend)):
        value = getattr(resend, name)
        if inspect.isclass(value) and value.__module__.startswith("resend") and value not in seen and has_class_methods(value):
            seen.add(value)
            walk(value, f"{name}.")
    return sorted(found)


def main() -> None:
    argv = sys.argv[1:]
    if argv[:1] == ["--methods"]:
        sys.stdout.write(json.dumps(public_methods()) + "\n")
        return
    plan = argv[:1] == ["--plan"]
    case = json.loads(argv[1] if plan else argv[0])
    if case["iterate"]:
        raise SystemExit("official python driver: the official SDKs have no iterator; cases with an oracle do not iterate")
    call = official_call(case)
    if call is None:
        raise SystemExit(f"official python driver: official-map.json has no Python method for {case['operation']}")
    if plan:
        sys.stdout.write(json.dumps(call, ensure_ascii=False, separators=(",", ":")) + "\n")
        return

    target: Any = resend
    for segment in call["method"].split("."):
        target = getattr(target, segment)
    error: dict[str, Any] | None = None
    try:
        target(*call["args"])
    except resend.exceptions.ResendError as raised:
        status = int(raised.code) if str(raised.code).isdigit() else None
        error = {"code": raised.error_type, "message": raised.message, "statusCode": status}

    line = {"case": case["case"], "surface": "official-python", "outcome": "ok" if error is None else "error", "error": error, "items": None, "exit_code": None}
    sys.stdout.write(json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
