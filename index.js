require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType
} = require('discord.js');
const { status, statusBedrock } = require('minecraft-server-util');
const fs = require('fs');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const DB_FILE = 'servers.json';
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')) : {};

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const CHECK_INTERVAL = 60000;
const tasks = new Map();

client.once(Events.ClientReady, async (c) => {
  console.log(`ChewieCraft Status Bot Online: ${c.user.tag}`);

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
  ];

  await client.application.commands.set(commands.map(cmd => cmd.toJSON()));
  console.log('Commands registered!');

  for (const guild of client.guilds.cache.values()) {
    if (db[guild.id]?.servers) startMonitoring(guild);
  }
});

// async function ensureCategory(guild) {
//   if (db[guild.id]?.categoryId) {
//     const cat = guild.channels.cache.get(db[guild.id].categoryId);
//     if (cat) return cat;
//   }

//   const category = await guild.channels.create({
//     name: 'Server Test',
//     type: ChannelType.GuildCategory
//   });

//   db[guild.id] = db[guild.id] || {};
//   db[guild.id].categoryId = category.id;
//   saveDB();
//   return category;
// }

function startMonitoring(guild) {
  if (tasks.has(guild.id)) clearInterval(tasks.get(guild.id));
  tasks.set(guild.id, setInterval(() => updateGuild(guild), CHECK_INTERVAL));
  updateGuild(guild);
}

async function updateGuild(guild) {
  const servers = db[guild.id]?.servers;
  if (!servers || Object.keys(servers).length === 0) return;

  const category = await ensureCategory(guild);
  let allOnline = true;

  for (const [host, cfg] of Object.entries(servers)) {
    const channel = guild.channels.cache.get(cfg.channelId);
    if (!channel) continue;

    if (channel.parentId !== category.id) {
      await channel.setParent(category.id).catch(() => {});
    }

    try {
      const result = cfg.bedrock
        ? await statusBedrock(host, cfg.port, { timeout: 5000 })
        : await status(host, cfg.port, { timeout: 5000, enableSRV: true });

      const online = result.players?.online ?? 0;
      const max = result.players?.max ?? 0;
      const name = cfg.onlineName
        .replace('{online}', online)
        .replace('{max}', max);

      await channel.setName(name.slice(0, 100));
    } catch (e) {
      allOnline = false;
      await channel.setName(cfg.offlineName.slice(0, 100));
    }
  }

  // Update category name with status emoji
  const statusEmoji = allOnline ? 'Online' : 'Offline';
  // const newName = allOnline ? 'Server Test' : 'Server Test';
  if (category.name !== newName) {
    await category.setName(newName).catch(() => {});
  }
}

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand() && !i.isAutocomplete()) return;

  const gid = i.guildId;
  if (!db[gid]) db[gid] = { servers: {} };

  if (i.isChatInputCommand()) {
    if (!i.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return i.reply({ content: 'You need **Manage Channels** permission!', ephemeral: true });
    }

    switch (i.commandName) {
      case 'addserver':
        const host = i.options.getString('host').trim();
        const type = i.options.getString('type');
        const port = i.options.getInteger('port') || (type === 'bedrock' ? 19132 : 25565);
        const bedrock = type === 'bedrock';
        let channel = i.options.getChannel('channel');

        if (!channel) {
          const category = await ensureCategory(i.guild);
          channel = await i.guild.channels.create({
            name: 'Loading...',
            type: ChannelType.GuildVoice,
            parent: category,
            permissionOverwrites: [{ id: i.guild.id, deny: ['Connect'] }]
          });
        }

        db[gid].servers[host] = {
          channelId: channel.id,
          port,
          bedrock,
          onlineName: `Online | {online}/{max} players`,
          offlineName: `Offline | Server down`
        };
        saveDB();
        startMonitoring(i.guild);

        await i.reply({
          content: `Monitoring **${host}:${port}**\nStatus channel: ${channel}`,
          ephemeral: false
        });
        break;

      case 'removeserver':
        const h = i.options.getString('host');
        if (!db[gid].servers[h]) return i.reply({ content: 'Not found!', ephemeral: true });
        delete db[gid].servers[h];
        if (Object.keys(db[gid].servers).length === 0) delete db[gid];
        saveDB();
        await i.reply({ content: `Stopped: \`${h}\``, ephemeral: false });
        break;

      case 'list':
        const list = Object.keys(db[gid]?.servers || {})
          .map(h => `• \`${h}:${db[gid].servers[h].port}\``)
          .join('\n') || 'None';
        await i.reply({ content: `**Servers:**\n${list}`, ephemeral: true });
        break;

      case 'status':
        await updateGuild(i.guild);
        await i.reply({ content: 'Updated!', ephemeral: true });
        break;
    }
  }

  if (i.isAutocomplete() && i.commandName === 'removeserver') {
    const focused = i.options.getFocused().toLowerCase();
    const matches = Object.keys(db[gid]?.servers || {}).filter(h => h.toLowerCase().includes(focused));
    await i.respond(matches.slice(0, 25).map(h => ({ name: h, value: h })));
  }
});

client.login(process.env.TOKEN);