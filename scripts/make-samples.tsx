/**
 * Generates synthetic provider price lists in ./samples so the pipeline can be tested
 * before the client sends real files.  Run: npx tsx --tsconfig tsconfig.cli.json scripts/make-samples.tsx
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import ExcelJS from "exceljs";
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

const dir = path.resolve(process.cwd(), "samples");
fs.mkdirSync(dir, { recursive: true });

async function makeExcel() {
  const wb = new ExcelJS.Workbook();

  // Sheet 1: classic table with a title row above the header, mixed notations, comma decimals
  const s1 = wb.addWorksheet("LISTA");
  s1.addRow(["LLANTAS DEL SUR S.A.C. - LISTA DE PRECIOS CAMIÓN", "", "", "", "", ""]);
  s1.addRow(["Precios en dólares, no incluyen IGV", "", "", "", "", ""]);
  s1.addRow([]);
  s1.addRow(["MARCA", "MEDIDA", "MODELO", "IC/IV", "PRECIO USD", "STOCK"]);
  s1.addRow(["MICHELIN", "295/80R22.5", "X MULTI Z", "152/148M", 410, 20]);
  s1.addRow(["MICHELIN", "295/80 R 22.5", "X MULTI D", "152/148L", 425.5, 8]);
  s1.addRow(["MICHELIN", "11R22.5", "XZE2+", "146/143L", 398, 0]);
  s1.addRow(["BRIDGESTONE", "11 R 22,5", "R268", "146/143L", 385, 15]);
  s1.addRow(["BRIDGESTONE", "295/80R22.5", "M840", "152/148M", 402, 6]);
  s1.addRow(["GOODYEAR", "12R22.5", "G686", "152/149L", 440, 4]);
  s1.addRow(["WESTLAKE", "1000R20", "CB972", "149/146K", 265, 30]);
  s1.addRow(["WESTLAKE", "10.00R20", "CR926", "149/146K", 258, 12]);
  s1.addRow(["DOUBLE COIN", "11R22.5", "RR680", "146/143L", 299, 25]);
  s1.addRow(["HANKOOK", "385/65R22.5", "AH35", "160K", 468, 3]);
  s1.addRow(["", "", "", "", "", ""]);
  s1.addRow(["TOTAL", "", "", "", 3850.5, ""]);

  // Sheet 2: brand section rows + description column (brand + model + size in one cell), PEN prices
  const s2 = wb.addWorksheet("CAMIONETA");
  s2.addRow(["DESCRIPCIÓN", "PRECIO S/", "DISPONIBLE"]);
  s2.addRow(["MICHELIN"]);
  s2.addRow(["MICHELIN LTX FORCE 265/70R16 112T", "S/ 820.00", "SI"]);
  s2.addRow(["MICHELIN AGILIS 3 205/65R16C", "S/ 690,00", "NO"]);
  s2.addRow(["PIRELLI"]);
  s2.addRow(["PIRELLI SCORPION ATR 31x10.50R15", "S/ 745.00", "SI"]);
  s2.addRow(["SCORPION HT LT265/70R17 121R", "S/ 910.00", "4"]);

  // Sheet 3: no header at all (just rows)
  const s3 = wb.addWorksheet("Hoja3");
  s3.addRow(["Triangle TR668 11R22.5", "$ 310"]);
  s3.addRow(["Triangle TR688 12R22.5", "$ 345"]);
  s3.addRow(["nota: precios válidos hasta el viernes"]);

  const buf = await wb.xlsx.writeBuffer();
  fs.writeFileSync(path.join(dir, "proveedor-a-lista.xlsx"), Buffer.from(buf));
}

function makeCsv() {
  const csv = [
    "Marca,Medida,Diseño,Precio (USD),Cant.",
    "Michelin,295/80R22.5,X Multi Z,\"1,250.00\",10",
    "Yokohama,11R22.5,TY517,\"$ 370.00\",7",
    "Yokohama,295/80R22.5,RY407,\"395\",",
    "Continental,315/80R22.5,HSR2,455.75,2",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "proveedor-c-lista.csv"), csv);
}

async function makePdf() {
  const styles = StyleSheet.create({
    page: { padding: 36, fontSize: 10, fontFamily: "Helvetica" },
    title: { fontSize: 14, marginBottom: 4 },
    sub: { fontSize: 9, marginBottom: 12, color: "#555" },
    row: { flexDirection: "row", paddingVertical: 3, borderBottom: "0.5 solid #ddd" },
    head: { flexDirection: "row", paddingVertical: 4, borderBottom: "1 solid #000", fontFamily: "Helvetica-Bold" },
    c1: { width: "16%" },
    c2: { width: "22%" },
    c3: { width: "20%" },
    c4: { width: "16%" },
    c5: { width: "14%", textAlign: "right" },
    c6: { width: "12%", textAlign: "right" },
    section: { marginTop: 8, fontFamily: "Helvetica-Bold" },
  });
  const rows: [string, string, string, string, string, string][] = [
    ["MICHELIN", "X MULTI Z", "295/80R22.5", "152/148M", "$ 415.00", "18"],
    ["MICHELIN", "XZE2+", "11R22.5", "146/143L", "$ 399.00", "10"],
    ["BRIDGESTONE", "R268", "11R22.5", "146/143L", "$ 380.00", "22"],
    ["BRIDGESTONE", "M840", "295/80R22.5", "152/148M", "$ 405.00", "5"],
    ["AEOLUS", "HN08", "11R22.5", "146/143L", "$ 275.00", "40"],
    ["AEOLUS", "HN355", "295/80R22.5", "152/148M", "$ 289.00", "16"],
    ["WESTLAKE", "CB972", "10.00R20", "149/146K", "$ 262.00", "9"],
  ];
  const doc = (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>IMPORTADORA NORTE E.I.R.L.</Text>
        <Text style={styles.sub}>Lista de precios camión y bus – vigente octubre 2026 – precios en US$ sin IGV</Text>
        <View style={styles.head}>
          <Text style={styles.c1}>MARCA</Text>
          <Text style={styles.c2}>DISEÑO</Text>
          <Text style={styles.c3}>MEDIDA</Text>
          <Text style={styles.c4}>IC/IV</Text>
          <Text style={styles.c5}>PRECIO</Text>
          <Text style={styles.c6}>STOCK</Text>
        </View>
        {rows.map((r, i) => (
          <View key={i} style={styles.row}>
            <Text style={styles.c1}>{r[0]}</Text>
            <Text style={styles.c2}>{r[1]}</Text>
            <Text style={styles.c3}>{r[2]}</Text>
            <Text style={styles.c4}>{r[3]}</Text>
            <Text style={styles.c5}>{r[4]}</Text>
            <Text style={styles.c6}>{r[5]}</Text>
          </View>
        ))}
        <Text style={styles.section}>Condiciones: pago contado, entrega en almacén Ate. Tel. 01 555 0101</Text>
      </Page>
    </Document>
  );
  const buf = await renderToBuffer(doc);
  fs.writeFileSync(path.join(dir, "proveedor-b-lista.pdf"), buf);
}

function makeWhatsApp() {
  const msgs: Record<string, string> = {
    "whatsapp-01.txt":
      "Buen día Carlos, precios de hoy: Michelin X Multi Z 295/80R22.5 a $410, Bridgestone R268 11R22.5 $385 c/u y 1000R20 Westlake CB972 a 290. Stock disponible, precios sin IGV.",
    "whatsapp-02.txt": ["Hola, lista Aeolus actualizada:", "HN08 11R22.5 - 270 usd (stock 40)", "HN355 295/80R22.5 - 285 usd (stock 12)", "HN230+ 12R22.5 - 310 usd", "Precios incluyen IGV. Saludos"].join("\n"),
    "whatsapp-03.txt": "Tengo 11R22.5 Double Coin RR680 a S/ 1,150 con IGV, quedan 8",
  };
  for (const [name, text] of Object.entries(msgs)) fs.writeFileSync(path.join(dir, name), text);
}

(async () => {
  await makeExcel();
  makeCsv();
  await makePdf();
  makeWhatsApp();
  console.log("samples written to", dir);
})();
