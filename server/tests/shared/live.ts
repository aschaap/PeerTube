/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import { expect } from 'chai'
import { pathExists, readdir } from 'fs-extra'
import { join } from 'path'
import { LiveVideo, VideoStreamingPlaylistType } from '@shared/models'
import { ObjectStorageCommand, PeerTubeServer } from '@shared/server-commands'
import { checkLiveSegmentHash, checkResolutionsInMasterPlaylist } from './streaming-playlists'
import { sha1 } from '@shared/extra-utils'

async function checkLiveCleanup (options: {
  server: PeerTubeServer
  videoUUID: string
  permanent: boolean
  savedResolutions?: number[]
}) {
  const { server, videoUUID, permanent, savedResolutions = [] } = options

  const basePath = server.servers.buildDirectory('streaming-playlists')
  const hlsPath = join(basePath, 'hls', videoUUID)

  if (permanent) {
    if (!await pathExists(hlsPath)) return

    const files = await readdir(hlsPath)
    expect(files).to.have.lengthOf(0)
    return
  }

  if (savedResolutions.length === 0) {
    return checkUnsavedLiveCleanup(server, videoUUID, hlsPath)
  }

  return checkSavedLiveCleanup(hlsPath, savedResolutions)
}

// ---------------------------------------------------------------------------

async function testVideoResolutions (options: {
  originServer: PeerTubeServer
  servers: PeerTubeServer[]
  liveVideoId: string
  resolutions: number[]
  transcoded: boolean
  objectStorage: boolean
}) {
  const { originServer, servers, liveVideoId, resolutions, transcoded, objectStorage } = options

  for (const server of servers) {
    const { data } = await server.videos.list()
    expect(data.find(v => v.uuid === liveVideoId)).to.exist

    const video = await server.videos.get({ id: liveVideoId })
    expect(video.streamingPlaylists).to.have.lengthOf(1)

    const hlsPlaylist = video.streamingPlaylists.find(s => s.type === VideoStreamingPlaylistType.HLS)
    expect(hlsPlaylist).to.exist
    expect(hlsPlaylist.files).to.have.lengthOf(0) // Only fragmented mp4 files are displayed

    await checkResolutionsInMasterPlaylist({
      server,
      playlistUrl: hlsPlaylist.playlistUrl,
      resolutions,
      transcoded,
      withRetry: objectStorage
    })

    if (objectStorage) {
      expect(hlsPlaylist.playlistUrl).to.contain(ObjectStorageCommand.getMockPlaylistBaseUrl())
    }

    for (let i = 0; i < resolutions.length; i++) {
      const segmentNum = 3
      const segmentName = `${i}-00000${segmentNum}.ts`
      await originServer.live.waitUntilSegmentGeneration({
        server: originServer,
        videoUUID: video.uuid,
        playlistNumber: i,
        segment: segmentNum,
        objectStorage
      })

      const baseUrl = objectStorage
        ? ObjectStorageCommand.getMockPlaylistBaseUrl() + 'hls'
        : originServer.url + '/static/streaming-playlists/hls'

      if (objectStorage) {
        expect(hlsPlaylist.segmentsSha256Url).to.contain(ObjectStorageCommand.getMockPlaylistBaseUrl())
      }

      const subPlaylist = await originServer.streamingPlaylists.get({
        url: `${baseUrl}/${video.uuid}/${i}.m3u8`,
        withRetry: objectStorage // With object storage, the request may fail because of inconsistent data in S3
      })

      expect(subPlaylist).to.contain(segmentName)

      await checkLiveSegmentHash({
        server,
        baseUrlSegment: baseUrl,
        videoUUID: video.uuid,
        segmentName,
        hlsPlaylist
      })

      if (originServer.internalServerNumber === server.internalServerNumber) {
        const infohash = sha1(`${2 + hlsPlaylist.playlistUrl}+V${i}`)
        const dbInfohashes = await originServer.sql.getPlaylistInfohash(hlsPlaylist.id)

        expect(dbInfohashes).to.include(infohash)
      }
    }
  }
}

// ---------------------------------------------------------------------------

export {
  checkLiveCleanup,
  testVideoResolutions
}

// ---------------------------------------------------------------------------

async function checkSavedLiveCleanup (hlsPath: string, savedResolutions: number[] = []) {
  const files = await readdir(hlsPath)

  // fragmented file and playlist per resolution + master playlist + segments sha256 json file
  expect(files).to.have.lengthOf(savedResolutions.length * 2 + 2)

  for (const resolution of savedResolutions) {
    const fragmentedFile = files.find(f => f.endsWith(`-${resolution}-fragmented.mp4`))
    expect(fragmentedFile).to.exist

    const playlistFile = files.find(f => f.endsWith(`${resolution}.m3u8`))
    expect(playlistFile).to.exist
  }

  const masterPlaylistFile = files.find(f => f.endsWith('-master.m3u8'))
  expect(masterPlaylistFile).to.exist

  const shaFile = files.find(f => f.endsWith('-segments-sha256.json'))
  expect(shaFile).to.exist
}

async function checkUnsavedLiveCleanup (server: PeerTubeServer, videoUUID: string, hlsPath: string) {
  let live: LiveVideo

  try {
    live = await server.live.get({ videoId: videoUUID })
  } catch {}

  if (live?.permanentLive) {
    expect(await pathExists(hlsPath)).to.be.true

    const hlsFiles = await readdir(hlsPath)
    expect(hlsFiles).to.have.lengthOf(1) // Only replays directory

    const replayDir = join(hlsPath, 'replay')
    expect(await pathExists(replayDir)).to.be.true

    const replayFiles = await readdir(join(hlsPath, 'replay'))
    expect(replayFiles).to.have.lengthOf(0)

    return
  }

  expect(await pathExists(hlsPath)).to.be.false
}
