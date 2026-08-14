export interface SlackMessage {
  ts: string;
  user: string | null;
  channel: string;
  text: string;
  permalink: string;
}

const BASE = 'https://slack.com/api';

export async function verifySlack(token: string): Promise<void> {
  const res = await fetch(`${BASE}/auth.test`, { headers: { Authorization: `Bearer ${token}` } });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack verification failed: ${data.error ?? res.status}`);
}

export function wrapUntrustedContent(content: string): string {
  return `<<<UNTRUSTED_CONTENT>>>\n${content}\n<<</UNTRUSTED_CONTENT>>>`;
}

export async function fetchSlackMessages(
  token: string,
  opts: { max?: number } = {}
): Promise<SlackMessage[]> {
  const channelsRes = await fetch(`${BASE}/conversations.list?types=public_channel,private_channel&limit=20&exclude_archived=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const channelsData = (await channelsRes.json()) as {
    ok?: boolean;
    channels?: { id: string; name: string }[];
  };
  if (!channelsData.ok || !channelsData.channels) {
    throw new Error(`Slack conversation list failed: ${JSON.stringify(channelsData)}`);
  }
  const max = opts.max ?? 20;
  const out: SlackMessage[] = [];
  for (const channel of channelsData.channels) {
    const res = await fetch(
      `${BASE}/conversations.history?channel=${channel.id}&limit=5`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = (await res.json()) as {
      ok?: boolean;
      messages?: { ts: string; user?: string; text?: string; permalink?: string }[];
    };
    if (!data.ok || !data.messages) continue;
    for (const msg of data.messages.slice(0, Math.min(5, Math.max(1, Math.floor(max / channelsData.channels.length) + 1)))) {
      out.push({
        ts: msg.ts,
        user: msg.user ?? null,
        channel: channel.name,
        text: wrapUntrustedContent(msg.text ?? ''),
        permalink: msg.permalink ?? '',
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}
