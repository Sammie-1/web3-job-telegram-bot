/**
 * bot.js
 * Single-file Web3 Job Bot
 * - Uses Telegraf for Telegram bot
 * - Polls RSS feeds, scores jobs, DMs users
 * - Uses Resend API for sending outreach emails if RESEND_API_KEY is set
 *
 * IMPORTANT: Copy .env.example -> .env and fill values before running.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios').default;
const { CronJob } = require('cron');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = Number(process.env.OWNER_TELEGRAM_ID || 0);
if (!BOT_TOKEN) console.warn('TELEGRAM_BOT_TOKEN not set — add it to .env');

const POLL_CRON = process.env.POLL_CRON || '*/5 * * * *';
const DAILY_DIGEST_HOUR = Number(process.env.DAILY_DIGEST_HOUR || 9);
const BOT_RETRY_DELAY_MS = Number(process.env.BOT_RETRY_DELAY_MS || 15000);

const KEYWORDS = (process.env.KEYWORDS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const RSS_FEEDS = (process.env.RSS_FEEDS || '').split(',').map(s => s.trim()).filter(Boolean);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || (process.env.MY_NAME || 'Emrys') + ' <you@example.com>';

const DB_FILE = path.join(__dirname, 'jobs.sqlite');
let sqlDatabase;
let db;

async function initDatabase() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, 'node_modules/sql.js/dist', file),
  });
  const buffer = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE) : null;
  sqlDatabase = buffer ? new SQL.Database(buffer) : new SQL.Database();
  db = {
    exec(sql) {
      sqlDatabase.exec(sql);
      persistDatabase();
    },
    prepare(sql) {
      return {
        run: (...params) => {
          sqlDatabase.run(sql, params);
          persistDatabase();
        },
        get: (...params) => {
          const stmt = sqlDatabase.prepare(sql, params);
          const hasRow = stmt.step();
          const row = hasRow ? stmt.getAsObject() : null;
          stmt.free();
          return row;
        },
        all: (...params) => {
          const stmt = sqlDatabase.prepare(sql, params);
          const rows = [];
          while (stmt.step()) {
            rows.push(stmt.getAsObject());
          }
          stmt.free();
          return rows;
        }
      };
    }
  };
  setupDatabase();
}

function persistDatabase() {
  if (!sqlDatabase) return;
  const data = Buffer.from(sqlDatabase.export());
  fs.writeFileSync(DB_FILE, data);
}

function setupDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      telegram_id INTEGER UNIQUE,
      portfolio TEXT,
      keywords TEXT,
      frequency TEXT DEFAULT 'instant'
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      title TEXT,
      company TEXT,
      link TEXT UNIQUE,
      excerpt TEXT,
      tags TEXT,
      posted_at TEXT,
      score REAL,
      status TEXT DEFAULT 'new',
      saved_by INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(score);
  `);
}

function scoreJob(title, excerpt, tagsText) {
  const text = (title + ' ' + (excerpt || '') + ' ' + (tagsText || '')).toLowerCase();
  let score = 0;
  const web3Keywords = ['web3','blockchain','ethereum','solidity','crypto','defi','base','dapp','smart contract','zk','layer2','evm'];
  const frontendKeywords = ['frontend','front-end','react','next','typescript','tailwind','ui engineer','ui developer','web developer','website','landing page'];

  for (const kw of KEYWORDS) {
    if (!kw) continue;
    if (text.includes(kw)) score += 1;
  }
  const hasWeb3 = web3Keywords.some(k => text.includes(k));
  const hasFrontend = frontendKeywords.some(k => text.includes(k));
  if (hasWeb3 && hasFrontend) score += 3;
  if (text.includes('website') || text.includes('landing page')) score += 2;
  if (text.includes('contract') || text.includes('freelance') || text.includes('short-term') || text.includes('bounty')) score += 2;
  if (text.includes('senior')) score += 0.5;
  return score;
}

function detectTags(text) {
  if (!text) return '';
  const txt = text.toLowerCase();
  const tags = [];
  if (txt.includes('solidity') || txt.includes('smart contract')) tags.push('Solidity');
  if (txt.includes('react')) tags.push('React');
  if (txt.includes('next')) tags.push('Next.js');
  if (txt.includes('frontend') || txt.includes('front-end')) tags.push('Frontend');
  if (txt.includes('website') || txt.includes('landing page')) tags.push('Website Build');
  if (txt.includes('blockchain') || txt.includes('web3') || txt.includes('crypto')) tags.push('Web3');
  if (txt.includes('contract') || txt.includes('freelance')) tags.push('Contract');
  return tags.join(', ');
}

function saveJobIfNew(source, title, company, link, excerpt, posted_at) {
  try {
    const tags = detectTags(title + ' ' + (excerpt || ''));
    const score = scoreJob(title, excerpt, tags);
    if (score <= 0) return null;
    const insert = db.prepare(`INSERT OR IGNORE INTO jobs (source,title,company,link,excerpt,tags,posted_at,score) VALUES (?,?,?,?,?,?,?,?)`);
    insert.run(source, title, company || '', link, excerpt || '', tags, posted_at || '', score);
    return db.prepare('SELECT * FROM jobs WHERE link = ?').get(link);
  } catch (e) {
    console.warn('DB save error', e.message);
    return null;
  }
}

async function fetchURL(url) {
  try {
    const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'web3-job-bot/1.0' }});
    return res.data;
  } catch (e) {
    console.warn('Fetch error', url, e.message);
    return null;
  }
}

function parseRSS(xml) {
  if (!xml) return [];
  const items = [];
  const parts = xml.split(/<item\b/gi);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const title = (chunk.match(/<title[^>]*>([^<]+)<\/title>/i) || [,'']).pop().trim();
    const link = (chunk.match(/<link[^>]*>([^<]+)<\/link>/i) || [,'']).pop().trim();
    const description = (chunk.match(/<(description|summary)[^>]*>([\\s\\S]*?)<\/\\1>/i) || [,'','']).pop().trim();
    const pub = (chunk.match(/<pubDate[^>]*>([^<]+)<\/pubDate>/i) || [,'']).pop().trim();
    items.push({ title, link, description, pubDate: pub });
  }
  return items;
}

async function processFeedsOnce(bot) {
  for (const feed of RSS_FEEDS) {
    if (!feed) continue;
    const xml = await fetchURL(feed);
    if (!xml) continue;
    const items = parseRSS(xml);
    for (const it of items) {
      if (!it.link) continue;
      const job = saveJobIfNew(feed, it.title || 'Untitled', '', it.link, it.description || '', it.pubDate || '');
      if (job) {
        const users = db.prepare('SELECT telegram_id FROM users').all().map(r => r.telegram_id);
        if (!users.includes(OWNER_ID)) users.push(OWNER_ID);
        for (const tg of users) {
          try {
            await sendJobToUser(bot, job, tg);
          } catch (e) {
            console.warn('sendJobToUser error', e.message);
          }
        }
        // mark as sent globally
        db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('sent', job.id);
      }
    }
  }
}

async function sendJobToUser(bot, job, telegramId) {
  if (!job) return;
  const text = `*${job.title}*\n${job.company ? '_' + job.company + '_\n' : ''}${job.excerpt ? job.excerpt.substring(0,300)+'...\n\n' : '\n'}Tags: ${job.tags || '—'}\n🔗 ${job.link}\n⭐ Score: ${job.score}\n🆔 ${job.id}`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('⭐ Save', `save_${job.id}`), Markup.button.callback('✉️ Contact Founder', `contact_${job.id}`)],
    [Markup.button.url('Apply (link)', job.link)]
  ]);
  await bot.telegram.sendMessage(telegramId, text, { parse_mode: 'Markdown', ...kb });
}

function extractEmail(text) {
  if (!text) return null;
  const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}

function findTelegramHandleInText(text) {
  if (!text) return null;
  const m = text.match(/@([a-zA-Z0-9_]{4,})/);
  return m ? m[1] : null;
}

function buildOutreachTemplate(job, from) {
  const name = job.company || 'Hiring team';
  const role = job.title || 'the role';
  const about = job.excerpt ? job.excerpt.replace(/\\n/g,' ').substring(0,240) + '...' : '';
  const skills = process.env.MY_SKILLS || 'React, Next.js, Typescript';
  const portfolio = process.env.PORTFOLIO_URL || '';
  const myName = process.env.MY_NAME || (from && from.first_name) || 'Applicant';
  const msg = `Hi ${name},

I'm ${myName} — a frontend developer experienced with ${skills}. I came across *${role}* and I'm excited about the opportunity because ${about}

You can see my work here: ${portfolio}

I'd love to chat for 10–15 minutes to discuss how I can help. I'm available this week for a short call and can start on a contract or full-time.

Thanks,
${myName}`;
  return msg;
}

async function sendResendEmail(to, subject, html) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured.');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      subject,
      html
    })
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error('Resend error: ' + resp.status + ' ' + body);
  }
  return resp.json();
}

// --- Bot setup and handlers ---
const bot = new Telegraf(BOT_TOKEN || '');

bot.start(async (ctx) => {
  const tgId = ctx.from.id;
  db.prepare('INSERT OR IGNORE INTO users (telegram_id, portfolio) VALUES (?,?)').run(tgId, process.env.PORTFOLIO_URL || '');
  await ctx.reply(`Hi ${ctx.from.first_name || 'there'} — I'm your job finder bot. I will DM top Web3 + Frontend job leads. Use /help for commands.`);
});

bot.command('help', (ctx) => {
  ctx.replyWithMarkdown(`
Commands:
/find - fetch top jobs now
/saved - show your saved/bookmarked jobs
/apply <id> - generate/send outreach message for job id
/settings - configure portfolio / frequency
/help - this message
`);
});

bot.command('find', async (ctx) => {
  await ctx.reply('Checking feeds now...');
  await processFeedsOnce(bot);
  ctx.reply('Done — latest jobs have been sent to your DM if any matched.');
});

bot.command('saved', async (ctx) => {
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(ctx.from.id);
  const rows = user ? db.prepare('SELECT * FROM jobs WHERE saved_by = ? ORDER BY created_at DESC').all(user.id || ctx.from.id) : [];
  if (!rows.length) return ctx.reply('No saved jobs yet.');
  let text = '*Saved Jobs*\n\n';
  for (const r of rows) {
    text += `*${r.title}*\n${r.company || ''}\n🔗 ${r.link}\nID: ${r.id}\nStatus: ${r.status}\n\n`;
  }
  ctx.replyWithMarkdown(text);
});

bot.command('apply', async (ctx) => {
  const text = ctx.message.text.replace('/apply','').trim();
  const id = Number(text);
  if (!id) return ctx.reply('Usage: /apply <job_id>');
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return ctx.reply('Job not found.');
  const template = buildOutreachTemplate(job, ctx.from);
  const kb = [];
  if (RESEND_API_KEY) kb.push(Markup.button.callback('Send as Email (Resend)', `sendemail_${id}`));
  kb.push(Markup.button.callback('Copy Template', `copy_${id}`));
  await ctx.replyWithMarkdown(`Use this template to reach out:\n\n${template}`, Markup.inlineKeyboard([kb]));
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('contacted', id);
});

bot.action(/save_(\d+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(ctx.from.id);
  db.prepare('UPDATE jobs SET saved_by = ? WHERE id = ?').run(user?.id || ctx.from.id, id);
  await ctx.answerCbQuery('Saved ✨');
});

bot.action(/contact_(\d+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return ctx.answerCbQuery('Job not found');
  const email = extractEmail(job.excerpt || job.title) || '';
  const telegramHandle = findTelegramHandleInText(job.excerpt || '') || '';
  const kb = [];
  if (email && RESEND_API_KEY) kb.push(Markup.button.callback('Send Email', `sendemail_${id}`));
  if (telegramHandle) kb.push(Markup.button.url('Open Telegram', `https://t.me/${telegramHandle}`));
  kb.push(Markup.button.callback('Copy Message', `copy_${id}`));
  kb.push(Markup.button.url('Open Apply Link', job.link));
  await ctx.replyWithMarkdown(`Contact options for *${job.title}*:`, Markup.inlineKeyboard([kb]));
  await ctx.answerCbQuery();
});

bot.action(/sendemail_(\d+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return ctx.answerCbQuery('Job not found');
  const to = extractEmail(job.excerpt || '') || null;
  if (!to) {
    await ctx.reply('No email found in job text. Use /sendto <id> email@example.com');
    return ctx.answerCbQuery();
  }
  const subject = `${process.env.MY_NAME || 'Applicant'} — Interest in ${job.title}`;
  const body = buildOutreachTemplate(job, ctx.from).replace(/\n/g,'<br/>');
  try {
    await sendResendEmail(to, subject, `<pre>${body}</pre>`);
    ctx.reply('Email sent ✅');
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('emailed', id);
  } catch (e) {
    ctx.reply('Failed to send: ' + e.message);
  }
  await ctx.answerCbQuery();
});

bot.action(/copy_(\d+)/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return ctx.answerCbQuery('Job not found');
  const tpl = buildOutreachTemplate(job, ctx.from);
  await ctx.reply(tpl);
  await ctx.answerCbQuery('Template sent to chat — copy & paste to contact the founder.');
});

bot.command('settings', (ctx) => {
  const text = `Settings:
- Portfolio: ${process.env.PORTFOLIO_URL || '(not set)'}
Set portfolio with: /setportfolio <url>
`;
  ctx.reply(text);
});

bot.command('setportfolio', (ctx) => {
  const url = ctx.message.text.replace('/setportfolio','').trim();
  if (!url) return ctx.reply('Usage: /setportfolio <url>');
  db.prepare('INSERT OR IGNORE INTO users (telegram_id, portfolio) VALUES (?,?)').run(ctx.from.id, url);
  db.prepare('UPDATE users SET portfolio = ? WHERE telegram_id = ?').run(url, ctx.from.id);
  ctx.reply('Portfolio saved.');
});

// sendTo command to send email manually: /sendto <id> email@example.com
bot.command('sendto', async (ctx) => {
  const parts = ctx.message.text.split(' ').slice(1);
  if (parts.length < 2) return ctx.reply('Usage: /sendto <jobid> <email>');
  const id = Number(parts[0]);
  const email = parts[1];
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return ctx.reply('Job not found');
  if (!RESEND_API_KEY) return ctx.reply('Resend not configured.');
  try {
    await sendResendEmail(email, `${process.env.MY_NAME || 'Applicant'} — Interest in ${job.title}`, `<pre>${buildOutreachTemplate(job, ctx.from).replace(/\n/g,'<br/>')}</pre>`);
    ctx.reply('Email sent ✅');
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('emailed', id);
  } catch (e) {
    ctx.reply('Failed to send: ' + e.message);
  }
});

function startFeedScheduler(botInstance) {
  processFeedsOnce(botInstance).catch(e => console.warn('Initial feeds error', e.message));
  const feedCron = new CronJob(POLL_CRON, () => {
    console.log('Cron: checking feeds', new Date().toISOString());
    processFeedsOnce(botInstance).catch(e => console.warn('processFeeds error', e.message));
  }, null, true);
  feedCron.start();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function launchBotWithRetry() {
  while (true) {
    try {
      await bot.launch();
      console.log('Bot launched (polling).');
      startFeedScheduler(bot);
      break;
    } catch (err) {
      console.error('Telegram bot launch failed:', err.message || err);
      if (err.code === 'ETIMEDOUT') {
        console.error('Telegram API timed out — check VPN/proxy/firewall settings.');
      }
      console.log(`Retrying in ${BOT_RETRY_DELAY_MS / 1000}s...`);
      await sleep(BOT_RETRY_DELAY_MS);
    }
  }
}

initDatabase()
  .then(() => {
    if (!BOT_TOKEN) {
      console.warn('Bot not started because TELEGRAM_BOT_TOKEN is missing.');
      return;
    }
    launchBotWithRetry();
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
  });
