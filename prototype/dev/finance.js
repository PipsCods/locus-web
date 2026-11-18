import { invoice, invoiceText, MATCH_INVOICE, usd } from "../shared/invoice.js";

const $ = (selector) => document.querySelector(selector);
const form = $("[data-review-form]");
const prompt = form.elements.prompt;
const button = form.querySelector("button");
const result = $("[data-review-result]");
const source = $("[data-review-source]");
const rows = $("[data-source-rows]");
const status = $("[data-review-status]");
const error = $("[data-review-error]");

$("[data-invoice-id]").textContent = invoice.id;
$("[data-finance-invoice]").textContent = invoiceText.split("\n").slice(1).join("\n");
prompt.value = MATCH_INVOICE;

function recordRow(label, record) {
  const title = document.createElement("dt");
  title.textContent = `${label} · ${record.id}`;
  const detail = document.createElement("dd");
  detail.textContent = `${record.units} units at ${usd(record.unit_price_usd)} each`;
  return [title, detail];
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  error.hidden = result.hidden = source.hidden = true;
  source.open = false;
  status.textContent = `Looking up ${invoice.purchaseOrder} and the goods receipt…`;
  try {
    const res = await fetch("/api/demo/recording/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: prompt.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error);
    const { purchase_order: po, goods_receipt: receipt } = data.source;
    rows.replaceChildren(...recordRow("Purchase order", po), ...recordRow("Goods receipt", receipt));
    $("[data-review-amount]").textContent = `${usd(data.discrepancy)} discrepancy`;
    $("[data-review-summary]").textContent = `The invoice bills for ${invoice.units} units. The purchase order and receipt both show ${receipt.units}. Flag the extra ${data.excess} units at ${usd(invoice.unitPrice)} each for review.`;
    status.textContent = `Retrieved ${po.id} and ${receipt.id}.`;
    result.hidden = source.hidden = false;
  } catch (err) {
    status.textContent = "";
    error.textContent = err.message || "The records could not be loaded. Try again.";
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});
