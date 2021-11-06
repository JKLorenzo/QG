import {
  AudioPlayerStatus,
  AudioResource,
  createAudioPlayer,
  DiscordGatewayAdapterCreator,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import {
  CommandInteraction,
  Guild,
  GuildMember,
  MessageComponentInteraction,
  Snowflake,
  TextChannel,
  VoiceState,
} from 'discord.js';
import fetch from 'node-fetch';
import playdl from 'play-dl';
import { client } from '../main.js';
import { getSoundCloudPlaylist, getSoundCloudTrack } from '../modules/soundcloud.js';
import { synthesize } from '../modules/speech.js';
import { getSpotifyAlbum, getSpotifyPlaylist, getSpotifyTrack } from '../modules/spotify.js';
import { logError } from '../modules/telemetry.js';
import Subscription from '../structures/subscription.js';
import Track from '../structures/track.js';

const _subscriptions = new Map<Snowflake, Subscription>();

export async function initMusic(): Promise<void> {
  const active_guilds = client.guilds.cache.filter(guild => {
    const member = guild.me;
    if (!member) return false;
    if (!member.voice.channelId) return false;
    return true;
  });

  if (active_guilds.size > 0) {
    const resource = await synthesize(
      'All queued music was removed due to a bot restart. I will now disconnect from this channel.',
    );
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    for (const guild of active_guilds.values()) {
      const channelId = guild.me?.voice.channelId;
      if (!channelId) continue;

      const connection = joinVoiceChannel({
        channelId: channelId,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      });

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        connection.subscribe(player);
      } catch (_) {
        connection.destroy();
      }
    }

    player.play(resource);

    player.on('stateChange', (oldState, newState) => {
      if (
        oldState.status === AudioPlayerStatus.Playing &&
        newState.status === AudioPlayerStatus.Idle
      ) {
        for (const guild of active_guilds.values()) {
          guild.me?.voice.disconnect();
        }
        player.removeAllListeners();
        console.log('Playback has stopped');
      }
    });
  }

  playdl.setToken({
    soundcloud: {
      client_id: process.env.SOUNDCLOUD_ID!,
    },
  });

  client.on('voiceStateUpdate', processVoiceStateUpdate);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function processVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  const bot_channel = oldState.guild.me?.voice.channel;
  const member_channel = oldState.channel;

  if (!bot_channel || !member_channel || bot_channel.id !== member_channel.id) return;
  if (bot_channel.members.filter(m => !m.user.bot).size > 0) return;

  const subscription = getSubscription(oldState.guild.id);
  if (subscription) {
    subscription.voiceConnection.destroy();
    deleteSubscription(oldState.guild.id);
  }
  await oldState.guild.me?.voice.disconnect();
}

export function getSubscription(guild_id: Snowflake): Subscription | undefined {
  return _subscriptions.get(guild_id);
}

export function setSubscription(guild_id: Snowflake, subscription: Subscription): void {
  _subscriptions.set(guild_id, subscription);
}

export function deleteSubscription(guild_id: Snowflake): void {
  _subscriptions.delete(guild_id);
}

export async function musicPlay(interaction: CommandInteraction): Promise<unknown> {
  await interaction.deferReply();

  const song = interaction.options.getString('song', true).trim();
  const guild = interaction.guild as Guild;
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  const current_voice_channel = guild.me?.voice.channel;
  let subscription = getSubscription(guild.id);

  if (!channel) return interaction.editReply('Join a voice channel and then try that again.');

  if (subscription && current_voice_channel && current_voice_channel.id !== channel.id) {
    return interaction.editReply("I'm currently playing on another channel.");
  }

  if (!subscription || !current_voice_channel) {
    subscription = new Subscription(
      joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      }),
    );
    subscription.voiceConnection.on('error', error => {
      logError('Music Manager', 'Voice Connection', error);
    });
    setSubscription(guild.id, subscription);
  }

  try {
    await entersState(subscription.voiceConnection, VoiceConnectionStatus.Ready, 20e3);
  } catch (_) {
    return interaction.editReply('Failed to join voice channel within 20 seconds.');
  }

  try {
    const enqueue = (query: string, title?: string, image?: string): Promise<number> =>
      subscription!.enqueue(interaction.channel as TextChannel, query, title, image);

    let type = await playdl.validate(song);
    if (type === 'search') {
      const results = await playdl.search(song, { limit: 1 });
      if (results.length === 0) return interaction.editReply('No match found.');

      const result = results[0] as playdl.YouTube;
      const video_info = await playdl.video_info(result.url!);

      const title = video_info.video_details.title?.trim();
      const author = video_info.video_details.channel?.name?.trim();

      const position = await enqueue(
        video_info.video_details.url,
        `${title} by ${author}`,
        video_info.video_details.thumbnail?.url,
      );

      await interaction.editReply(
        `Enqueued **${title}** by **${author}**${position > 0 ? ` at position ${position}` : ''}.`,
      );
    } else {
      // Handle shortened urls
      const redirect = await fetch(song);
      const url = redirect.url;
      type = await playdl.validate(redirect.url);

      if (type === 'yt_video') {
        const video_info = await playdl.video_info(url);

        const title = video_info.video_details.title?.trim();
        const author = video_info.video_details.channel?.name?.trim();

        const position = await enqueue(
          url,
          `${title} by ${author}`,
          video_info.video_details.thumbnail?.url,
        );

        await interaction.editReply(
          `Enqueued **${title}** by **${author}**${
            position > 0 ? ` at position ${position}` : ''
          }.`,
        );
      } else if (type === 'yt_playlist') {
        const playlist_info = await playdl.playlist_info(url);
        await playlist_info.fetch();

        const playlist_title = playlist_info.title?.trim();
        const playlist_author = playlist_info.channel?.name?.trim();

        for (let page = 1; page <= playlist_info.total_pages; page++) {
          const video_infos = await playlist_info.page(page);

          for (let i = video_infos.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const temp = video_infos[i];
            video_infos[i] = video_infos[j];
            video_infos[j] = temp;
          }

          for (const video_info of video_infos) {
            const title = video_info.title?.trim();
            const author = video_info.channel?.name?.trim();
            await enqueue(video_info.url, `${title} by ${author}`, video_info.thumbnail?.url);
          }
        }

        await interaction.editReply(
          `Enqueued ${playlist_info.total_videos} songs from **${playlist_title}** playlist ` +
            `by **${playlist_author}**.`,
        );
      } else if (type === 'sp_track') {
        const spotify_info = await getSpotifyTrack(url);
        if (!spotify_info) return interaction.editReply('Spotify track not found.');

        const name = spotify_info.name?.trim();
        const author = spotify_info.artists
          .map(a => a.name)
          .join(', ')
          .trim();

        const position = await enqueue(
          `${name} by ${author}`,
          `${name} by ${author}`,
          spotify_info.album.images[0].url,
        );

        await interaction.editReply(
          `Enqueued **${name}** by **${author}**${position > 0 ? ` at position ${position}` : ''}.`,
        );
      } else if (type === 'sp_playlist') {
        const spotify_playlist = await getSpotifyPlaylist(url);
        if (!spotify_playlist) return interaction.editReply('Spotify playlist not found.');

        const playlist_title = spotify_playlist.name.trim();
        const playlist_author = spotify_playlist.owner.display_name?.trim();

        const spotify_infos = [...spotify_playlist.tracks.items];
        for (let i = spotify_infos.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const temp = spotify_infos[i];
          spotify_infos[i] = spotify_infos[j];
          spotify_infos[j] = temp;
        }

        let queued = 0;
        for (const spotify_info of spotify_infos) {
          const name = spotify_info.track.name?.trim();
          const artists = spotify_info.track.artists
            .map(a => a.name)
            .join(', ')
            .trim();

          await enqueue(
            `${name} by ${artists}`,
            `${name} by ${artists}`,
            spotify_info.track.album.images[0].url,
          );
          queued++;
        }

        await interaction.editReply(
          `Enqueued ${queued} songs from **${playlist_title}** playlist by **${playlist_author}**.`,
        );
      } else if (type === 'sp_album') {
        const spotify_album = await getSpotifyAlbum(url);
        if (!spotify_album) return interaction.editReply('Spotify album not found.');

        const album_title = spotify_album.name.trim();
        const album_author = spotify_album.artists
          .map(a => a.name)
          .join(', ')
          .trim();

        const spotify_infos = [...spotify_album.tracks.items];
        for (let i = spotify_infos.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const temp = spotify_infos[i];
          spotify_infos[i] = spotify_infos[j];
          spotify_infos[j] = temp;
        }

        let queued = 0;
        for (const spotify_info of spotify_infos) {
          const name = spotify_info.name.trim();
          const artists = spotify_info.artists
            .map(a => a.name)
            .join(', ')
            .trim();

          await enqueue(
            `${name} by ${artists}`,
            `${name} by ${artists}`,
            spotify_album.images[0].url,
          );
          queued++;
        }

        await interaction.editReply(
          `Enqueued ${queued} songs from **${album_title}** album by **${album_author}**.`,
        );
      } else if (type === 'so_track') {
        const soundcloud_info = await getSoundCloudTrack(url);
        if (!soundcloud_info) return interaction.editReply('SoundCloud track not found.');

        const track_title = soundcloud_info.title.trim();
        const track_author = soundcloud_info.author.name.trim();

        const position = await enqueue(
          soundcloud_info.url,
          `${track_title} by ${track_author}`,
          soundcloud_info.thumbnail,
        );

        await interaction.editReply(
          `Enqueued **${track_title}** by **${track_author}**${
            position > 0 ? ` at position ${position}` : ''
          }.`,
        );
      } else if (type === 'so_playlist') {
        const soundcloud_playlist = await getSoundCloudPlaylist(url);
        if (!soundcloud_playlist) return interaction.editReply('SoundCloud playlist not found.');

        const playlist_title = soundcloud_playlist.title.trim();
        const playlist_author = soundcloud_playlist.author.name.trim();

        const soundcloud_infos = [...soundcloud_playlist.tracks];
        for (let i = soundcloud_infos.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const temp = soundcloud_infos[i];
          soundcloud_infos[i] = soundcloud_infos[j];
          soundcloud_infos[j] = temp;
        }

        for (const soundcloud_info of soundcloud_infos) {
          const track_title = soundcloud_info.title.trim();
          const track_author = soundcloud_info.author.name.trim();
          await enqueue(
            soundcloud_info.url,
            `${track_title} by ${track_author}`,
            soundcloud_info.thumbnail,
          );
        }

        await interaction.editReply(
          `Enqueued ${soundcloud_playlist.trackCount} songs from **${playlist_title}** playlist ` +
            `by **${playlist_author}**.`,
        );
      } else {
        await interaction.editReply('This URL is currently not supported.');
      }
    }
  } catch (error) {
    await interaction.editReply(`Failed to play track due to an error.\n\`\`\`${error}\`\`\``);
  }
}

export async function musicSkip(
  interaction: CommandInteraction | MessageComponentInteraction,
): Promise<unknown> {
  const guild = interaction.guild as Guild;
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  const current_voice_channel = guild.me?.voice.channel;
  const subscription = getSubscription(guild.id);

  if (!subscription) return interaction.reply('Not playing in this server.');

  if (!current_voice_channel || !channel || current_voice_channel.id !== channel.id) {
    return interaction.reply({
      content: "You must be on the same channel where I'm currently active to perform this action.",
    });
  }

  let skipped = 0;
  if (interaction instanceof CommandInteraction) {
    const count = interaction.options.getInteger('count', false) ?? 1;
    skipped = subscription.stop({ skipCount: count });
  } else {
    skipped = subscription.stop({ skipCount: 1 });
  }

  await interaction.reply({
    content: `${interaction.member} skipped ${skipped} ${skipped === 1 ? 'song' : 'songs'}.`,
    allowedMentions: {
      parse: [],
    },
  });
}

export async function musicStop(
  interaction: CommandInteraction | MessageComponentInteraction,
): Promise<unknown> {
  const guild = interaction.guild as Guild;
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  const current_voice_channel = guild.me?.voice.channel;
  const subscription = getSubscription(guild.id);

  if (!subscription) return interaction.reply('Not playing in this server.');

  if (!current_voice_channel || !channel || current_voice_channel.id !== channel.id) {
    return interaction.reply(
      "You must be on the same channel where I'm currently active to perform this action.",
    );
  }

  const cleared = subscription.stop();

  await interaction.reply({
    content: `Playback stopped by ${interaction.member}, and ${cleared} ${
      cleared === 1 ? 'song is' : 'songs are'
    } removed from the queue.`,
    allowedMentions: {
      parse: [],
    },
  });
}

export async function musicQueue(
  interaction: CommandInteraction | MessageComponentInteraction,
): Promise<void> {
  const guild = interaction.guild as Guild;
  const subscription = getSubscription(guild.id);

  if (!subscription) return interaction.reply('Not playing in this server.');

  if (subscription.audioPlayer.state.status === AudioPlayerStatus.Idle) {
    return interaction.reply({
      content: 'Nothing is currently playing.',
      ephemeral: true,
    });
  } else {
    const resource = subscription.audioPlayer.state.resource as AudioResource<Track>;
    const queue = subscription.queue
      .slice(0, 10)
      .map((track, index) => `${index + 1}) ${track.title}`)
      .join('\n');

    await interaction.reply({
      content: `**Now Playing:**\n${resource.metadata.title}\n\n**On Queue: ${subscription.queue.length}**\n${queue}`,
      ephemeral: true,
    });
  }
}

export async function musicPause(
  interaction: CommandInteraction | MessageComponentInteraction,
): Promise<unknown> {
  const guild = interaction.guild as Guild;
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  const current_voice_channel = guild.me?.voice.channel;
  const subscription = getSubscription(guild.id);

  if (subscription && current_voice_channel?.id !== channel?.id) {
    return interaction.reply(
      "You must be on the same channel where I'm currently active to perform this action.",
    );
  }

  if (!subscription) return interaction.reply('Not playing in this server.');

  subscription.audioPlayer.pause();

  await interaction.reply({
    content: `Playback paused by ${interaction.member}.`,
    allowedMentions: {
      parse: [],
    },
  });
}

export async function musicResume(
  interaction: CommandInteraction | MessageComponentInteraction,
): Promise<unknown> {
  const guild = interaction.guild as Guild;
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  const current_voice_channel = guild.me?.voice.channel;
  const subscription = getSubscription(guild.id);

  if (subscription && current_voice_channel?.id !== channel?.id) {
    return interaction.reply({
      content: "You must be on the same channel where I'm currently active to perform this action.",
      ephemeral: true,
    });
  }

  if (!subscription) return interaction.reply('Not playing in this server.');

  subscription.audioPlayer.unpause();

  await interaction.reply({
    content: `Playback resumed by ${interaction.member}.`,
    allowedMentions: {
      parse: [],
    },
  });
}

export async function musicLeave(
  interaction: CommandInteraction | MessageComponentInteraction,
): Promise<unknown> {
  const guild = interaction.guild as Guild;
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  const current_voice_channel = guild.me?.voice.channel;
  const subscription = getSubscription(guild.id);

  if (subscription && current_voice_channel && current_voice_channel?.id !== channel?.id) {
    return interaction.reply(
      "You must be on the same channel where I'm currently active to perform this action.",
    );
  }

  if (!subscription) return interaction.reply('Not playing in this server.');

  if (subscription) {
    subscription.voiceConnection.destroy();
    deleteSubscription(guild.id);
  } else {
    guild.me?.voice.disconnect();
  }

  await interaction.reply({
    content: `Voice channel disconnect initiated by ${interaction.member}.`,
    allowedMentions: {
      parse: [],
    },
  });
}
