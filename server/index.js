#!/usr/bin/env node
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT || 7070);
const app = createApp();

app.listen(PORT, "127.0.0.1", () => {
  console.log(`gRPC station listening on http://127.0.0.1:${PORT}`);
});
