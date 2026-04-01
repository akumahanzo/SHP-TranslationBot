import Discord from "discord.js";
import "dotenv/config";

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ApplicationCommandType, ContextMenuCommandBuilder } = Discord;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages
  ]
});

const CHANNEL_A = process.env.SRC_CHANNEL_ID;
const CHANNEL_B = process.env.TGT_CHANNEL_ID;

const LANGUAGES = [
  { name: "Arabic", value: "ar" },
  { name: "English", value: "en" },
  { name: "French", value: "fr" },
  { name: "Spanish", value: "es" },
  { name: "German", value: "de" },
  { name: "Turkish", value: "tr" },
  { name: "Russian", value: "ru" },
  { name: "Chinese", value: "zh" },
  { name: "Italian", value: "it" },
  { name: "Portuguese", value: "pt" },
];

const commands = [
  new SlashCommandBuilder()
    .setName("translate")
    .setDescription("Translate text to a chosen language")
    .addStringOption(opt =>
      opt.setName("to")
        .setDescription("Target language")
        .setRequired(true)
        .addChoices(...LANGUAGES)
    )
    .addStringOption(opt =>
      opt.setName("text")
        .setDescription("Text to translate (or reply to a message to translate that instead)")
        .setRequired(false)
    ),
  new ContextMenuCommandBuilder()
    .setName("Translate message")
    .setType(ApplicationCommandType.Message),
].map(cmd => cmd.toJSON());

function extractMentions(text) {
  const mentionRegex = /<(@!?\d+|@&\d+|#\d+|a?:[a-zA-Z0-9_]+:\d+)>/g;
  const mentions = [];
  const clean = text.replace(mentionRegex, (match) => {
    const index = mentions.length;
    mentions.push(match);
    return `M${index}MENTION`;
  });
  return { clean, mentions };
}

function restoreMentions(text, mentions) {
  return text.replace(/M(\d+)MENTION/g, (_, i) => mentions[parseInt(i)] ?? _);
}

async function translateWithLingva(text, sourceLang, targetLang) {
  const url = `https://lingva.ml/api/v1/${sourceLang}/${targetLang}/${encodeURIComponent(text)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const data = await res.json();
  if (!data.translation) throw new Error("Lingva: no translation returned");
  return data.translation;
}

async function translateWithMyMemory(text, sourceLang, targetLang) {
  const src = sourceLang === "auto" ? "autodetect" : sourceLang;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${src}|${targetLang}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const data = await res.json();
  if (data.responseStatus !== 200) throw new Error(`MyMemory: ${data.responseDetails}`);
  return data.responseData.translatedText;
}

async function translateText(text, sourceLang, targetLang) {
  const { clean, mentions } = extractMentions(text);
  let translated;
  try {
    translated = await translateWithLingva(clean, sourceLang, targetLang);
  } catch (e) {
    console.warn("Lingva failed, falling back to MyMemory:", e.message);
    translated = await translateWithMyMemory(clean, sourceLang, targetLang);
  }
  return restoreMentions(translated, mentions);
}

async function registerCommands(clientId) {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("Slash commands registered globally.");
}

client.on("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Translating between channels ${CHANNEL_A} <-> ${CHANNEL_B}`);
  await registerCommands(client.user.id);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  let targetChannelId = null;
  let sourceLang = null;
  let targetLang = null;

  if (message.channel.id === CHANNEL_A) {
    targetChannelId = CHANNEL_B;
    sourceLang = "auto";
    targetLang = "en";
  } else if (message.channel.id === CHANNEL_B) {
    targetChannelId = CHANNEL_A;
    sourceLang = "auto";
    targetLang = "ar";
  } else {
    return;
  }

  try {
    const translated = await translateText(message.content, sourceLang, targetLang);
    const target = await client.channels.fetch(targetChannelId);
    await target.send(`**${message.member.displayName}:** ${translated}`);
  } catch (e) {
    console.error("Translation error:", e);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "translate") {
    await interaction.deferReply({ ephemeral: false });

    const targetLang = interaction.options.getString("to");
    const inputText = interaction.options.getString("text");
    const langName = LANGUAGES.find(l => l.value === targetLang)?.name ?? targetLang;

    let textToTranslate = inputText;

    if (!textToTranslate && interaction.channel) {
      const messages = await interaction.channel.messages.fetch({ limit: 10 });
      const replied = messages.find(m => !m.author.bot && m.id !== interaction.id);
      if (replied) textToTranslate = replied.content;
    }

    if (!textToTranslate) {
      return interaction.editReply("No text found to translate. Provide text or reply to a message.");
    }

    try {
      const translated = await translateText(textToTranslate, "auto", targetLang);
      await interaction.editReply(`**Translated to ${langName}:**\n${translated}`);
    } catch (e) {
      await interaction.editReply("Translation failed. Please try again.");
      console.error(e);
    }
  }

  if (interaction.isMessageContextMenuCommand() && interaction.commandName === "Translate message") {
    await interaction.deferReply({ ephemeral: true });

    const targetMsg = interaction.targetMessage;
    const channelId = interaction.channelId;

    let targetLang = "en";
    let langName = "English";

    if (channelId === CHANNEL_A) {
      targetLang = "en";
      langName = "English";
    } else if (channelId === CHANNEL_B) {
      targetLang = "ar";
      langName = "Arabic";
    }

    try {
      const translated = await translateText(targetMsg.content, "auto", targetLang);
      await interaction.editReply(`**Translated to ${langName}:**\n${translated}`);
    } catch (e) {
      await interaction.editReply("Translation failed. Please try again.");
      console.error(e);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
