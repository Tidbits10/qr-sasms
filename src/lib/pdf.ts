
function safe(value: unknown) {
  return String(value ?? "")
    .replace(/[\\()]/g, "\\$&")
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "?");
}

function wrap(value: unknown, width = 82) {
  const words = safe(value).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (`${line} ${word}`.trim().length > width && line) { lines.push(line); line = word; }
    else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  return lines;
}

export function documentPdf(kind: "approval" | "receipt", r: Record<string, unknown>) {
  const heading = kind === "receipt" ? "DOCUMENT CLAIM RECEIPT" : "DOCUMENT APPROVAL CERTIFICATE";
  const rows = kind === "receipt"
    ? [["Claiming reference", r.claimRef], ["Request reference", r.id], ["Student", r.studentName], ["Student number", r.studentId], ["Document", r.doc], ["Purpose", r.purpose], ["Copies", r.copies], ["Claimed at", r.claimedAt], ["Released by", r.claimedBy], ["Status", "COMPLETED"]]
    : [["Request reference", r.id], ["Student", r.studentName], ["Student number", r.studentId], ["Document", r.doc], ["Purpose", r.purpose], ["Copies", r.copies], ["Submitted", r.createdAt], ["Current status", r.status], ["Integrity signature", r.signature]];
  const lines = ["POLYTECHNIC UNIVERSITY OF THE PHILIPPINES", "San Pedro Campus - Student Services Office", "", heading, ""];
  rows.forEach(([label, value]) => wrap(`${label}: ${value || "-"}`).forEach((line) => lines.push(line)));
  lines.push("", "Digitally issued by QR-SASMS.", `Generated: ${new Date().toLocaleString("en-PH")}`);
  const text = lines.map((line, index) => `BT /F${index < 5 ? 2 : 1} ${index === 0 ? 16 : index === 3 ? 15 : 10} Tf 54 ${790 - index * 18} Td (${safe(line)}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${Buffer.byteLength(text, "utf8")} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, index) => { offsets.push(Buffer.byteLength(pdf, "utf8")); pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}
