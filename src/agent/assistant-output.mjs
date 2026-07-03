export function getAssistantText(response) {
  const message = response?.message;
  if (message) {
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((block) => block?.kind === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
      if (text) return text;
    }
  }
  if (typeof response?.stdout === "string") return response.stdout;
  return "";
}

export function formatAssistantText(text) {
  if (!text) return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}
