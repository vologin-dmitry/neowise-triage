import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 3900 + Math.floor(Math.random() * 500);
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server;

async function waitForServer(attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/`);
      if (response.ok) return;
    } catch {
      // сервер ещё не поднялся — пробуем снова
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Сервер не запустился за отведённое время");
}

function post(body) {
  return fetch(`${BASE_URL}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

before(async () => {
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer();
});

after(() => {
  server?.kill();
});

test("некорректный ввод возвращает 400 invalid_input", async () => {
  const invalidBodies = [
    "",
    "не json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ text: "" }),
    JSON.stringify({ text: "   " }),
    JSON.stringify({ text: 42 }),
    JSON.stringify({ text: null }),
    JSON.stringify({ message: "доставка" }),
  ];

  for (const body of invalidBodies) {
    const response = await post(body);
    assert.equal(response.status, 400, `тело: ${body}`);
    assert.deepEqual(await response.json(), { status: "invalid_input" }, `тело: ${body}`);
  }
});

test("корректная заявка возвращает ready с темой и черновиком", async () => {
  const response = await post(JSON.stringify({ text: "Когда будет доставка заказа?" }));

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, "ready");
  assert.equal(data.topic, "delivery");
  assert.equal(typeof data.draft, "string");
  assert.ok(data.draft.trim().length > 0);
});

test("тема pricing распознаётся корректно", async () => {
  const response = await post(JSON.stringify({ text: "Какая цена на услугу?" }));

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, "ready");
  assert.equal(data.topic, "pricing");
});

for (const marker of ["[bad-json]", "[bad-topic]", "[empty-draft]", "[error]"]) {
  test(`сбой модели ${marker} возвращает manual_review`, async () => {
    const response = await post(JSON.stringify({ text: `Заявка ${marker}` }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "manual_review",
      topic: null,
      draft: null,
    });
  });
}

test("таймаут модели ограничен 300 мс и возвращает manual_review", async () => {
  const startedAt = Date.now();
  const response = await post(JSON.stringify({ text: "Заявка [timeout]" }));
  const elapsed = Date.now() - startedAt;

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "manual_review",
    topic: null,
    draft: null,
  });
  // Имитатор отвечает через 1200 мс, но сервер должен прервать ожидание на 300 мс.
  assert.ok(elapsed < 1000, `ответ занял ${elapsed} мс`);
});
