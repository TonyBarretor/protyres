import ExcelJS from "exceljs";
const [file, pattern, limit = 40] = process.argv.slice(2);
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const ws = wb.worksheets[0];
const re = new RegExp(pattern, "i");
let n = 0, total = 0;
ws.eachRow((row, i) => {
  const vals = [];
  row.eachCell({ includeEmpty: true }, (c) => { let v = c.value; if (v && typeof v === "object") v = v.richText ? v.richText.map(t=>t.text).join("") : (v.result ?? v.text ?? ""); vals.push(v == null ? "" : String(v)); });
  const line = vals.join(" | ");
  if (re.test(line)) { total++; if (n++ < +limit) console.log(i, "|", line); }
});
console.log("total matches:", total);
