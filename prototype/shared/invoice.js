export const invoice = {
  id: "INV-1042",
  supplier: "Kestrel Valve & Pump",
  purchaseOrder: "PO-1842",
  item: "Valve assemblies",
  units: 120,
  unitPrice: 45,
};

export const usd = (amount) => new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
}).format(amount);

export const invoiceText = [
  `Supplier invoice ${invoice.id}`,
  `Supplier: ${invoice.supplier}`,
  `Purchase order: ${invoice.purchaseOrder}`,
  `Item: ${invoice.item}`,
  `Quantity billed: ${invoice.units}`,
  `Unit price: ${usd(invoice.unitPrice)} USD`,
  `Total due: ${usd(invoice.units * invoice.unitPrice)} USD`,
].join("\n");
export const EXTRACT_INVOICE = "What is the invoice total and purchase order reference?";
export const CHECK_RECORDS = "What records would you check before paying this invoice?";
export const MATCH_INVOICE = `Does invoice ${invoice.id} match ${invoice.purchaseOrder} and the goods receipt?`;
export const PLAN_INVOICE_RESOLUTION = `Finance is holding invoice ${invoice.id} until the discrepancy is resolved. What amount do the records support? What should we verify if the supplier says the rest shipped separately? Draft a short email asking the supplier to resolve the discrepancy.`;
