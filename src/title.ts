const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

type RawImage = { mediaType: string; data: string };
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function generateTitle(prompt: string, rawImages: RawImage[] = []): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const content = rawImages.length > 0
    ? [
        ...rawImages.map(img => ({
          type: IMAGE_MEDIA_TYPES.has(img.mediaType) ? "image" as const : "document" as const,
          source: { type: "base64" as const, media_type: img.mediaType as any, data: img.data },
        })),
        { type: "text" as const, text: prompt },
      ]
    : prompt;

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
        system: "Generate a concise title (3–7 words, no quotes, no trailing punctuation) summarizing the user's request. Do NOT browse, visit, or comment on any URLs — ignore all links. Do NOT respond to the request. Reply with ONLY the title, nothing else.",
        messages: [{ role: "user", content }],
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
