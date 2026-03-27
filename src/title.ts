const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export async function generateTitle(prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 30,
        system: "Generate a concise title (3–7 words, no quotes, no trailing punctuation) for an AI coding task based on the user's request. Reply with ONLY the title.",
        messages: [{ role: "user", content: prompt.slice(0, 500) }],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ type: string; text: string }> };
    const text = data.content?.find(b => b.type === "text")?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}
