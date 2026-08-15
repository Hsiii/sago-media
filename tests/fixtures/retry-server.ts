let attempts = 0;

Bun.serve({
  port: Number(process.env.PORT),
  async fetch(request) {
    if (new URL(request.url).pathname === "/health") return new Response("ok\n");
    if (new URL(request.url).pathname !== "/v1/uploads" || request.method !== "POST") return new Response("Not found.\n", { status: 404 });
    attempts += 1;
    await request.arrayBuffer();
    if (attempts === 1) return new Response("Busy.\n", { status: 429, headers: { "Retry-After": "0" } });
    return Response.json({ markdown: "![PR preview](https://media.example.test/retried.png)", url: "https://media.example.test/retried.png", previewUrl: null });
  },
});
