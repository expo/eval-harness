export function getTitleAndPreview(body) {
  if (!body || !body.trim()) {
    return { title: 'New Note', preview: '' };
  }
  const lines = body.split(/\r?\n/);
  let titleIdx = -1;
  let title = 'New Note';
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) {
      title = trimmed;
      titleIdx = i;
      break;
    }
  }
  let preview = '';
  for (let j = titleIdx + 1; j < lines.length; j++) {
    const trimmed = lines[j].trim();
    if (trimmed.length > 0) {
      preview = trimmed;
      break;
    }
  }
  return { title, preview };
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

export function formatTimestamp(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = pad2(d.getUTCMonth() + 1);
  const da = pad2(d.getUTCDate());
  const h = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  return `${y}-${mo}-${da} ${h}:${mi}`;
}

export function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
