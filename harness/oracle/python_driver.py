# python3 -I harness/oracle/python_driver.py '<case JSON>'
# Driver of the own Python SDK (contract §7): runs a neutral case (§8) with the
# method that names.python of the IR gives, against RESEND_BASE_URL with
# RESEND_API_KEY, and prints one results.jsonl line. Run from the repository root.
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdks" / "python" / "src"))

from paridad_resend import ParidadError, Resend  # noqa: E402


def main() -> None:
    case = json.loads(sys.argv[1])
    ir = json.loads(Path("ir/ir.json").read_text(encoding="utf-8"))
    op = next((candidate for candidate in ir["operations"] if candidate["id"] == case["operation"]), None)
    if op is None:
        raise SystemExit(f"python driver: unknown operation {case['operation']}")

    resource_name, method_name = op["names"]["python"].split(".")
    resource = getattr(Resend(), resource_name)
    args: list[object] = [str(case["path"][parameter["name"]]) for parameter in op["pathParams"]]
    kwargs: dict[str, object] = {}
    error: ParidadError | None = None
    items: list[object] | None = None

    if case["iterate"]:
        pagination = op["pagination"]
        if pagination is None:
            raise SystemExit(f"python driver: {op['id']} does not paginate")
        cursors = (pagination["after"], pagination["before"])
        if any(parameter["name"] not in cursors for parameter in op["queryParams"]):
            args.append(case["query"])
        items = []
        try:
            for item in getattr(resource, f"{method_name}_all")(*args):
                items.append(item)
        except ParidadError as raised:
            error = raised
    else:
        if op["requestBody"] is not None:
            args.append(case["body"])
        if op["queryParams"]:
            args.append(case["query"])
        if op["idempotency"] and case["idempotency_key"] is not None:
            kwargs["idempotency_key"] = case["idempotency_key"]
        try:
            getattr(resource, method_name)(*args, **kwargs)
        except ParidadError as raised:
            error = raised

    line = {
        "case": case["case"],
        "surface": "python",
        "outcome": "ok" if error is None else "error",
        "error": None if error is None else {"code": error.code, "message": error.message, "statusCode": error.status_code},
        "items": items,
        "exit_code": None,
    }
    sys.stdout.write(json.dumps(line, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
