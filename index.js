// index.js
require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  REST,
  Routes,
} = require('discord.js');

const { status, statusBedrock } = require('minecraft-server-util');
const fs = require('fs/promises');
const path = require('path');

const DB_FILE = path.resolve(__dirname, 'servers.json');
const TMP_DB_FILE = `${DB_FILE}.tmp`;
const CHECK_INTERVAL = 60 * 1000; // 1 minute
const SERVER_NAME_MAX = 100;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const tasks = new Map(); // guildId -> intervalId

// --- Helpers: safe DB read/write ---
async function loadDB() {
  try {
    const text = await fs.readFile(DB_FILE, 'utf-8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error('Failed to load DB:', err);
    return {}; // degrade gracefully
  }
}

async function saveDBAtomic(db) {
  try {
    const text = JSON.stringify(db, null, 2);
    await fs.writeFile(TMP_DB_FILE, text, 'utf-8');
    await fs.rename(TMP_DB_FILE, DB_FILE);
  } catch (err) {
    console.error('Failed to save DB atomically:', err);
    // best-effort: try direct write
    try {
      await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
    } catch (e) {
      console.error('Fallback write failed:', e);
    }
  }
}

// load DB to memory
let db = {};
(async () => { db = await loadDB(); })();

// --- Safe wrapper around long operations to avoid blocking reply time ---
async function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error('timeout'));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

// --- Monitoring logic ---
async function updateGuild(guild) {
  // isolate errors per guild
  try {
    const guildCfg = db[guild.id];
    const servers = guildCfg?.servers;
    if (!servers || Object.keys(servers).length === 0) return;

    // loop through servers in parallel but keep each guarded
    await Promise.allSettled(Object.entries(servers).map(async ([host, cfg]) => {
      try {
        const channel = await fetchChannelSafe(guild, cfg.channelId);
        if (!channel) {
          console.warn(`Channel ${cfg.channelId} not found in guild ${guild.id} for server ${host}`);
          return;
        }

        // only try to rename if manageable / guild has permission
        if (!channel.manageable) {
          console.warn(`Channel ${channel.id} not manageable in guild ${guild.id}. Skipping rename.`);
          return;
        }

        // call status with an explicit timeout (server util has its own timeout but we guard too)
        const attempt = async () => {
          if (cfg.bedrock) {
            return await statusBedrock(host, cfg.port, { timeout: 5000 });
          } else {
            return await status(host, cfg.port, { timeout: 5000, enableSRV: true });
          }
        };

        const result = await withTimeout(attempt(), 7000); // 7s per-host upper bound

        const online = result.players?.online ?? 0;
        const max = result.players?.max ?? 0;
        const name = (cfg.onlineName || 'Online | {online}/{max}')
          .replace('{online}', online)
          .replace('{max}', max)
          .slice(0, SERVER_NAME_MAX);

        // Only set name if different (reduces rate limits)
        if (channel.name !== name) {
          await channel.setName(name);
        }
      } catch (err) {
        // on error, set offlineName if manageable
        try {
          const channel = await fetchChannelSafe(guild, cfg.channelId);
          if (channel && channel.manageable) {
            const offlineName = (cfg.offlineName || 'Offline | Server down').slice(0, SERVER_NAME_MAX);
            if (channel.name !== offlineName) await channel.setName(offlineName);
          }
        } catch (inner) {
          console.error(`Failed to set offline name for ${host} in ${guild.id}:`, inner);
        }
        console.warn(`Server check failed for ${host} in guild ${guild.id}:`, err && err.message ? err.message : err);
      }
    }));
  } catch (err) {
    // keep errors from bubbling
    console.error('updateGuild unexpected error:', err);
  }
}

// safe fetch channel (handles partial caches)
async function fetchChannelSafe(guild, channelId) {
  try {
    // prefer cache but fetch when missing
    let ch = guild.channels.cache.get(channelId);
    if (!ch) {
      ch = await guild.channels.fetch(channelId).catch(() => null);
    }
    return ch ?? null;
  } catch (err) {
    console.error('fetchChannelSafe error:', err);
    return null;
  }
}

function startMonitoring(guild) {
  try {
    stopMonitoring(guild.id);
    // run immediately then schedule
    updateGuild(guild).catch(err => console.error('Initial updateGuild error:', err));
    const id = setInterval(() => updateGuild(guild).catch(err => console.error('Scheduled updateGuild error:', err)), CHECK_INTERVAL);
    tasks.set(guild.id, id);
  } catch (err) {
    console.error('startMonitoring error:', err);
  }
}

function stopMonitoring(guildId) {
  const id = tasks.get(guildId);
  if (id) {
    clearInterval(id);
    tasks.delete(guildId);
  }
}

// --- Command definitions (same commands, built with builder) ---
const commands = [
  new SlashCommandBuilder()
    .setName('addserver')
    .setDescription('Add a Minecraft server')
    .addStringOption(o => o.setName('host').setDescription('IP/domain').setRequired(true))
    .addStringOption(o => o
      .setName('type')
      .setDescription('Java or Bedrock')
      .setRequired(true)
      .addChoices({ name: 'Java', value: 'java' }, { name: 'Bedrock', value: 'bedrock' }))
    .addIntegerOption(o => o.setName('port').setDescription('Port').setRequired(false))
    .addChannelOption(o => o.setName('channel').setDescription('Voice channel').setRequired(false).addChannelTypes(ChannelType.GuildVoice)),

  new SlashCommandBuilder()
    .setName('removeserver')
    .setDescription('Remove a server')
    .addStringOption(o => o.setName('host').setDescription('Host').setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder().setName('list').setDescription('List servers'),
  new SlashCommandBuilder().setName('status').setDescription('Force update')
].map(c => c.toJSON());

// --- Register commands on ready using REST to application commands (global) ---
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('Commands registered globally');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// --- Event handlers ---
client.once(Events.ClientReady, async (c) => {
  console.log(`Ready as ${c.user.tag}`);
  await registerCommands();

  // start monitoring for guilds that have configured servers
  for (const guild of client.guilds.cache.values()) {
    if (db[guild.id]?.servers && Object.keys(db[guild.id].servers).length > 0) {
      startMonitoring(guild);
    }
  }
});

// robust interaction handler
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      // removeserver autocomplete
      if (interaction.commandName === 'removeserver') {
        const gid = interaction.guildId;
        const focused = (interaction.options.getFocused() || '').toLowerCase();
        const matches = Object.keys(db[gid]?.servers || {}).filter(h => h.toLowerCase().includes(focused));
        await interaction.respond(matches.slice(0, 25).map(h => ({ name: h, value: h })));
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const gid = interaction.guildId;
    if (!gid) return interaction.reply({ content: 'This command must be used in a guild.', ephemeral: true });

    // ensure structure exists
    if (!db[gid]) db[gid] = { servers: {} };

    // permission check
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      // defer and edit not necessary here since quick reply
      return interaction.reply({ content: 'You need **Manage Channels** permission!', ephemeral: true });
    }

    switch (interaction.commandName) {
      case 'addserver': {
        // defer immediately to avoid timeout if something heavy happens
        await interaction.deferReply({ ephemeral: true });

        const host = interaction.options.getString('host').trim();
        const type = interaction.options.getString('type');
        const port = interaction.options.getInteger('port') || (type === 'bedrock' ? 19132 : 25565);
        const bedrock = type === 'bedrock';
        let channel = interaction.options.getChannel('channel');

        // default: if not provided, try to find a voice channel in the guild where user can manage
        if (!channel) {
          // pick first manageable voice channel
          channel = interaction.guild.channels.cache.find(c => c.type === ChannelType.GuildVoice && c.manageable) || null;
          if (!channel) {
            // create ephemeral message and abort
            await interaction.editReply({ content: 'No voice channel provided and none found that is manageable.' });
            return;
          }
        }

        db[gid].servers[host] = {
          channelId: channel.id,
          port,
          bedrock,
          onlineName: `Online | {online}/{max} players`,
          offlineName: `Offline | Server down`
        };

        await saveDBAtomic(db);
        startMonitoring(interaction.guild);

        await interaction.editReply({
          content: `Monitoring **${host}:${port}**\nStatus channel: ${channel}`
        });
        break;
      }

      case 'removeserver': {
        await interaction.deferReply({ ephemeral: true });

        const host = interaction.options.getString('host');
        if (!db[gid].servers[host]) {
          await interaction.editReply({ content: 'Not found!' });
          break;
        }

        delete db[gid].servers[host];
        if (Object.keys(db[gid].servers).length === 0) {
          delete db[gid];
          stopMonitoring(gid);
        }
        await saveDBAtomic(db);
        await interaction.editReply({ content: `Stopped monitoring \`${host}\`` });
        break;
      }

      case 'list': {
        // this is cheap - no need to defer
        const list = Object.keys(db[gid]?.servers || {})
          .map(h => `• \`${h}:${db[gid].servers[h].port}\``)
          .join('\n') || 'None';
        await interaction.reply({ content: `**Servers:**\n${list}`, ephemeral: true });
        break;
      }

      case 'status': {
        // long operation - defer then run
        await interaction.deferReply({ ephemeral: true });
        // run update but don't allow it to throw to the top-level
        await updateGuild(interaction.guild);
        await interaction.editReply({ content: 'Updated!' });
        break;
      }

      default:
        await interaction.reply({ content: 'Unknown command', ephemeral: true });
    }
  } catch (err) {
    // handle interaction-specific errors and avoid crashing the process
    console.error('Interaction handler error:', err);
    try {
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'An error occurred. Check logs.', ephemeral: true });
      } else if (interaction && (interaction.replied || interaction.deferred)) {
        await interaction.editReply({ content: 'An error occurred. Check logs.' }).catch(() => null);
      }
    } catch (replyErr) {
      console.error('Failed to notify user about error:', replyErr);
    }
  }
});

// --- Safe lifecycle / crash prevention ---
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // attempt a graceful shutdown
  try {
    for (const id of tasks.values()) clearInterval(id);
    client.destroy();
  } finally {
    // allow process to exit after cleanup
    process.exit(1);
  }
});

// graceful exit on SIGINT / SIGTERM
async function shutdown() {
  console.log('Shutting down gracefully...');
  for (const id of tasks.values()) clearInterval(id);
  try { await saveDBAtomic(db); } catch (e) { console.warn('Failed to save DB on shutdown:', e); }
  await client.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- start bot ---
(async () => {
  try {
    if (!process.env.TOKEN) throw new Error('TOKEN not provided in .env');
    if (!process.env.CLIENT_ID) console.warn('CLIENT_ID not provided — command registration may fail.');

    await client.login(process.env.TOKEN);
    console.log('Login initiated');
  } catch (err) {
    console.error('Failed to start client:', err);
    process.exit(1);
  }
})();
