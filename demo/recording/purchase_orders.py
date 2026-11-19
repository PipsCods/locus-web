# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp==1.26.0"]
# ///
"""Read-only fictional purchase-order source for the Invoice Review assistant."""

import json
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

record = json.loads(Path(__file__).with_name("purchase-order.json").read_text(encoding="utf-8"))
server = FastMCP("Purchasing records", host="127.0.0.1", port=8765, stateless_http=True, json_response=True)


@server.tool(annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
def get_purchase_order(purchase_order_id: str) -> dict:
    """Look up a purchase order by ID and return the order and its goods receipt."""
    if purchase_order_id == record["purchase_order"]["id"]:
        return record
    return {"error": "Purchase order not found"}


if __name__ == "__main__":
    server.run(transport="streamable-http")
