// Generates fake data so you can preview the dashboard before connecting Smartlead.
// Run: node scripts/make-demo-data.mjs   (overwrites public/data/*.json)
import { writeFile, mkdir } from "node:fs/promises";

const names = ["Founders – SaaS India", "Agency outreach Q3", "Webinar follow-up", "CFO cold list", "Re-engage 2025 leads", "Hiring managers US"];
const statuses = ["ACTIVE", "ACTIVE", "COMPLETED", "ACTIVE", "PAUSED", "ACTIVE"];
const days = 45;
const rnd = (a, b) => Math.round(a + Math.random() * (b - a));

const running = names.map(() => ({ sent: 0, unique_sent: 0, unique_opened: 0, clicked: 0, replied: 0, bounced: 0, unsubscribed: 0 }));
const snapshots = [];
const start = new Date();
start.setDate(start.getDate() - days + 1);

for (let d = 0; d < days; d++) {
  const date = new Date(start);
  date.setDate(start.getDate() + d);
  const iso = date.toISOString().slice(0, 10);
  const campaigns = {};
  running.forEach((r, i) => {
    const active = statuses[i] === "ACTIVE" || d < days - 10;
    const sent = active ? rnd(40, 220) : 0;
    const us = Math.round(sent * 0.7);
    r.sent += sent;
    r.unique_sent += us;
    r.unique_opened += Math.round(us * (0.35 + Math.random() * 0.25));
    r.clicked += Math.round(us * 0.03 * Math.random());
    r.replied += Math.round(us * (0.01 + Math.random() * 0.03));
    r.bounced += Math.round(sent * 0.02 * Math.random());
    r.unsubscribed += Math.round(sent * 0.005 * Math.random());
    campaigns[1000 + i] = { ...r };
  });
  snapshots.push({ date: iso, campaigns });
}

const last = snapshots.at(-1);
const latest = {
  updated_at: new Date().toISOString(),
  date: last.date,
  time_zone: "Asia/Kolkata",
  demo: true,
  campaigns: names.map((name, i) => {
    const s = last.campaigns[1000 + i];
    return {
      id: 1000 + i, name, status: statuses[i], created_at: snapshots[0].date, client: null, plain_text: false,
      ...s,
      opened: Math.round(s.unique_opened * 1.6),
      unique_clicked: Math.round(s.clicked * 0.8),
      leads_total: s.unique_sent + rnd(200, 900),
      leads_interested: Math.round(s.replied * 0.3),
    };
  }),
};

await mkdir("public/data", { recursive: true });
await writeFile("public/data/latest.json", JSON.stringify(latest, null, 2));
await writeFile("public/data/history.json", JSON.stringify({ snapshots }));
console.log("Demo data written to public/data/");
