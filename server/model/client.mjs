import { HttpError } from "../shared/errors.mjs";

export function createModelClient({ config, http }) {
  const providerConfig = config.text || config;

  return {
    async completeStructured({ messages, schema, schemaName, images = [], timeoutMs = 150_000, signal, onProgress } = {}) {
      ensureConfigured(providerConfig);
      return providerConfig.provider === "openai"
        ? completeResponses({ providerConfig, http, messages, schema, schemaName, images, timeoutMs, signal, onProgress })
        : completeChat({ providerConfig, http, messages, schema, schemaName, images, timeoutMs, signal, onProgress });
    },
  };
}

async function completeResponses({ providerConfig, http, messages, schema, schemaName, images, timeoutMs, signal, onProgress }) {
  const input = toResponsesInput(messages, images);
  const body = {
    model: providerConfig.model,
    input,
    text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
    ...(onProgress ? { stream: true } : {}),
  };
  onProgress?.({ type: "request", message: "Model request sent" });
  const response = await http.fetch(`${providerConfig.baseUrl}/responses`, {
    method: "POST", headers: jsonHeaders(providerConfig), body: JSON.stringify(body),
  }, { timeoutMs, signal });
  if (!response.ok) throw await upstreamError(response);
  const text = onProgress ? await readResponsesStream(response, onProgress) : extractResponseText(await readJson(response));
  const value = parseAndValidate(text, schema);
  if (!value) throw new HttpError(502, "Model returned invalid structured JSON");
  return { value, apiCalls: 1, provider: providerConfig.provider, model: providerConfig.model };
}

async function completeChat({ providerConfig, http, messages, schema, schemaName, images, timeoutMs, signal, onProgress }) {
  const body = {
    model: providerConfig.model,
    messages: toChatMessages(messages, images),
    response_format: { type: "json_object" },
    temperature: 0.25,
    ...(onProgress ? { stream: true } : {}),
  };
  let apiCalls = 0;
  let response = await requestChat(body, "Model request sent");
  if (!response.ok && response.status === 400) {
    await readJson(response);
    delete body.response_format;
    response = await requestChat(body, "Compatibility retry sent");
  }
  if (!response.ok) throw await upstreamError(response);
  const firstText = await chatText(response, onProgress);
  const firstValue = parseAndValidate(firstText, schema);
  if (firstValue) return result(firstValue);

  const repairMessages = [...body.messages];
  if (firstText) repairMessages.push({ role: "assistant", content: firstText });
  repairMessages.push({
    role: "user",
    content: `Repair the previous output. Return only valid JSON matching schema ${schemaName}: ${JSON.stringify(schema)}`,
  });
  const repairBody = { ...body, messages: repairMessages, temperature: 0 };
  response = await requestChat(repairBody, "JSON repair request sent");
  if (!response.ok) throw await upstreamError(response);
  const repairedValue = parseAndValidate(await chatText(response, onProgress), schema);
  if (!repairedValue) throw new HttpError(502, "Model failed to return valid structured JSON after one repair");
  return result(repairedValue);

  async function requestChat(requestBody, message) {
    apiCalls += 1;
    onProgress?.({ type: "request", message });
    return http.fetch(`${providerConfig.baseUrl}/chat/completions`, {
      method: "POST", headers: jsonHeaders(providerConfig), body: JSON.stringify(requestBody),
    }, { timeoutMs, signal });
  }

  function result(value) {
    return { value, apiCalls, provider: providerConfig.provider, model: providerConfig.model };
  }
}

function toResponsesInput(messages = [], images = []) {
  const input = messages.map((message) => ({ role: message.role, content: responsesContent(message.content) }));
  appendResponseImages(input, images);
  return input;
}

function responsesContent(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [{ type: "input_text", text: JSON.stringify(content ?? "") }];
  return content.map((item) => {
    if (typeof item === "string") return { type: "input_text", text: item };
    if (item?.type === "image_url") return { type: "input_image", image_url: item.image_url?.url || item.image_url, detail: "high" };
    return item?.type?.startsWith("input_") ? item : { type: "input_text", text: item?.text || JSON.stringify(item) };
  });
}

function appendResponseImages(input, images) {
  if (!images.length) return;
  let user = [...input].reverse().find((message) => message.role === "user");
  if (!user) { user = { role: "user", content: [] }; input.push(user); }
  for (const image of images) {
    user.content.push({ type: "input_text", text: `Attachment: ${image.name || "image"}${image.summary ? `; ${image.summary}` : ""}` });
    user.content.push({ type: "input_image", image_url: image.dataUrl, detail: "high" });
  }
}

function toChatMessages(messages = [], images = []) {
  const output = messages.map((message) => ({ role: message.role, content: message.content }));
  if (!images.length) return output;
  let index = output.findLastIndex((message) => message.role === "user");
  if (index < 0) { output.push({ role: "user", content: [] }); index = output.length - 1; }
  const original = output[index].content;
  const content = Array.isArray(original) ? [...original] : [{ type: "text", text: String(original ?? "") }];
  for (const image of images) {
    content.push({ type: "text", text: `Attachment: ${image.name || "image"}${image.summary ? `; ${image.summary}` : ""}` });
    content.push({ type: "image_url", image_url: { url: image.dataUrl } });
  }
  output[index] = { ...output[index], content };
  return output;
}

async function chatText(response, onProgress) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("text/event-stream")) return extractChatText(await readJson(response));
  let text = "";
  await readSse(response, (_event, data) => {
    const delta = flattenText(data?.choices?.[0]?.delta?.content);
    if (!delta) return;
    text += delta;
    onProgress?.({ type: "delta", deltaChars: delta.length, totalChars: text.length });
  });
  return text;
}

async function readResponsesStream(response, onProgress) {
  let text = "";
  let completed = "";
  await readSse(response, (event, data) => {
    const type = data?.type || event;
    if (type === "response.output_text.delta" && typeof data?.delta === "string") {
      text += data.delta;
      onProgress({ type: "delta", deltaChars: data.delta.length, totalChars: text.length });
    } else if (type === "response.completed") completed = extractResponseText(data?.response || data);
    else if (type === "response.failed" || type === "error") throw new HttpError(502, data?.error?.message || "Model stream failed");
  });
  return text || completed;
}

async function readSse(response, onEvent) {
  if (!response.body) throw new HttpError(502, "Upstream response stream is empty");
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (block) => {
    let event = "";
    const lines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
    }
    const raw = lines.join("\n");
    if (!raw || raw === "[DONE]") return;
    try { onEvent(event, JSON.parse(raw)); } catch (error) { if (error instanceof SyntaxError) return; throw error; }
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    blocks.forEach(consume);
  }
  consume(buffer + decoder.decode());
}

function parseAndValidate(text, schema) {
  try {
    const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let value;
    try { value = JSON.parse(cleaned); } catch {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      value = JSON.parse(cleaned.slice(start, end + 1));
    }
    return validates(value, schema) ? value : null;
  } catch { return null; }
}

function validates(value, schema) {
  if (!schema || typeof schema !== "object") return true;
  if (schema.anyOf) return schema.anyOf.some((candidate) => validates(value, candidate));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (Array.isArray(schema.type)) return schema.type.some((type) => validates(value, { ...schema, type }));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if ((schema.required || []).some((key) => !(key in value))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in (schema.properties || {})))) return false;
    return Object.entries(schema.properties || {}).every(([key, child]) => !(key in value) || validates(value[key], child));
  }
  if (schema.type === "array") {
    return Array.isArray(value)
      && (schema.minItems == null || value.length >= schema.minItems)
      && (schema.maxItems == null || value.length <= schema.maxItems)
      && value.every((item) => validates(item, schema.items));
  }
  if (schema.type === "string") {
    return typeof value === "string"
      && (schema.minLength == null || value.length >= schema.minLength)
      && (schema.maxLength == null || value.length <= schema.maxLength);
  }
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "integer") return Number.isInteger(value);
  if (schema.type === "null") return value === null;
  return true;
}

function ensureConfigured(config) {
  if (!config?.baseUrl || !config?.model) throw new HttpError(500, "Model provider is not configured");
  if (!config.apiKey && !isLocal(config.baseUrl)) throw new HttpError(400, "OPENAI_API_KEY is not configured");
}

function jsonHeaders(config) {
  return { ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}), "Content-Type": "application/json" };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { error: { message: text.replace(/\s+/g, " ").slice(0, 300) } }; }
}

async function upstreamError(response) {
  const payload = await readJson(response);
  return new HttpError(response.status >= 500 ? 502 : response.status, payload?.error?.message || payload?.message || `Upstream returned ${response.status}`);
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output || []).flatMap((item) => item?.content || []).map((item) => item?.text || item?.value || "").filter(Boolean).join("\n");
}

function extractChatText(payload) {
  const choice = payload?.choices?.[0] || {};
  return flattenText(choice?.message?.content) || flattenText(choice?.message?.reasoning_content) || flattenText(choice.text) || extractResponseText(payload);
}

function flattenText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join("\n");
  if (!value || typeof value !== "object") return "";
  return flattenText(value.text ?? value.value ?? value.content);
}

function isLocal(value) {
  try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(value).hostname); } catch { return false; }
}
