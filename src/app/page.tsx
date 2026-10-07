export default function Home() {
  return (
    <main>
      <h1>Protyres – cotizador (piloto)</h1>
      <p>El bot vive en WhatsApp. Esta página solo confirma que el servicio está arriba.</p>
      <ul>
        <li>
          Webhook WhatsApp: <code>/api/whatsapp/webhook</code>
        </li>
        <li>
          Refresco de precios (cron): <code>/api/ingest/refresh</code>
        </li>
        <li>
          Estado: <code>/api/health</code>
        </li>
      </ul>
    </main>
  );
}
