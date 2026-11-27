import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const MODEL_TIMEOUT_MS = 300;
const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function invalidInput(response) {
  return json(response, 400, { status: "invalid_input" });
}

function manualReview(response) {
  return json(response, 200, { status: "manual_review", topic: null, draft: null });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Вызывает модель и ждёт не дольше MODEL_TIMEOUT_MS.
 * Таймаут прерывает запрос через AbortSignal и дополнительно
 * ограничивает ожидание гонкой промисов на случай, если модель
 * игнорирует сигнал.
 */
async function requestModel(text) {
  const controller = new AbortController();
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("model timeout"));
    }, MODEL_TIMEOUT_MS);
  });

  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Проверяет ответ модели: валидный JSON, допустимая тема,
 * непустой черновик. Возвращает нормализованный результат или null.
 */
function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const { topic, draft } = parsed;
  if (!ALLOWED_TOPICS.has(topic)) return null;
  if (!draft || typeof draft !== "string" || draft.trim() === "") return null;

  return { topic, draft: draft.trim() };
}

async function handleTriage(request, response) {
  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch {
    return invalidInput(response);
  }

  const text = payload !== null && typeof payload === "object" ? payload.text : undefined;
  if (typeof text !== "string" || text.trim() === "") {
    return invalidInput(response);
  }

  let raw;
  try {
    raw = await requestModel(text);
  } catch {
    return manualReview(response);
  }

  const result = parseModelOutput(raw);
  if (!result) {
    return manualReview(response);
  }

  return json(response, 200, {
    status: "ready",
    topic: result.topic,
    draft: result.draft,
  });
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
}).listen(Number(process.env.PORT || 3000), "127.0.0.1");
