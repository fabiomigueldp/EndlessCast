const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');

const URL = 'https://markup.uguu.io/example_prada.json';
const CHECK_INTERVAL = 60 * 1000; // Verifica a cada 1 minuto

const PLAYLISTS_DIR = path.join(__dirname, 'playlists');
const PLAYLIST_NAME = 'example_prada';
const PLAYLIST_DIR = path.join(PLAYLISTS_DIR, PLAYLIST_NAME);
const ORIGINAL_DIR = path.join(PLAYLIST_DIR, 'original');
const HLS_DIR = path.join(PLAYLIST_DIR, 'HLS');

let previousPlaylistJSON = null;

async function checkAndUpdatePlaylist() {
    try {
        // Busca o arquivo JSON
        const response = await axios.get(URL);
        const playlistJSON = response.data;

        // Verifica se o JSON mudou
        const playlistChanged = JSON.stringify(playlistJSON) !== JSON.stringify(previousPlaylistJSON);

        if (playlistChanged) {
            console.log('A playlist mudou. Atualizando...');

            // Atualiza o JSON anterior
            previousPlaylistJSON = playlistJSON;

            // Garante que os diretórios existam
            ensureDirectories();

            // Baixa os arquivos de mídia
            await downloadMediaFiles(playlistJSON.media_files);

            // Processa os arquivos de mídia
            await processMediaFiles(playlistJSON.media_files);
        } else {
            console.log('A playlist não mudou.');
        }
    } catch (error) {
        console.error('Erro ao verificar ou atualizar a playlist:', error);
    }
}

function ensureDirectories() {
    if (!fs.existsSync(PLAYLISTS_DIR)) {
        fs.mkdirSync(PLAYLISTS_DIR);
    }
    if (!fs.existsSync(PLAYLIST_DIR)) {
        fs.mkdirSync(PLAYLIST_DIR);
    }
    if (!fs.existsSync(ORIGINAL_DIR)) {
        fs.mkdirSync(ORIGINAL_DIR);
    }
    if (!fs.existsSync(HLS_DIR)) {
        fs.mkdirSync(HLS_DIR);
    }
}

async function downloadMediaFiles(mediaFiles) {
    for (const media of mediaFiles) {
        const mediaUrl = media.media_url;
        const mediaId = media.media_id;
        const order = media.order;

        const filename = `${order}_${mediaId}.mp4`;
        const filepath = path.join(ORIGINAL_DIR, filename);

        // Verifica se o arquivo já existe
        if (fs.existsSync(filepath)) {
            console.log(`Arquivo de mídia ${filename} já existe. Pulando download.`);
            continue;
        }

        // Baixa o arquivo
        console.log(`Baixando arquivo de mídia ${filename}...`);
        const writer = fs.createWriteStream(filepath);

        const response = await axios({
            url: mediaUrl,
            method: 'GET',
            responseType: 'stream'
        });

        response.data.pipe(writer);

        // Espera o download terminar
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log(`Arquivo de mídia ${filename} baixado.`);
    }
}

async function processMediaFiles(mediaFiles) {
    // Analisa os arquivos de mídia para garantir compatibilidade
    const mediaInfos = [];

    for (const media of mediaFiles) {
        const order = media.order;
        const mediaId = media.media_id;
        const filename = `${order}_${mediaId}.mp4`;
        const filepath = path.join(ORIGINAL_DIR, filename);

        const mediaInfo = await getMediaInfo(filepath);
        mediaInfos.push({ filepath, mediaInfo });
    }

    // Verifica se todos os arquivos têm as mesmas propriedades
    const firstMediaInfo = mediaInfos[0].mediaInfo;
    let compatible = true;

    for (const { mediaInfo } of mediaInfos) {
        if (!compareMediaInfo(firstMediaInfo, mediaInfo)) {
            compatible = false;
            break;
        }
    }

    if (!compatible) {
        console.log('Arquivos de mídia não são compatíveis. Transcodificando para formato comum...');
        // Transcodifica os arquivos para um formato comum
        for (const { filepath } of mediaInfos) {
            await transcodeMediaFile(filepath);
        }
    } else {
        console.log('Arquivos de mídia são compatíveis.');
    }

    // Concatena os arquivos de mídia
    console.log('Concatenando arquivos de mídia...');
    const concatFilePath = path.join(HLS_DIR, 'concat.txt');

    // Cria o arquivo de concatenação
    const concatFileContent = mediaInfos.map(({ filepath }) => `file '${filepath.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(concatFilePath, concatFileContent);

    // Executa o FFmpeg para concatenar e segmentar em HLS
    console.log('Gerando segmentos HLS...');
    const hlsOutputPath = path.join(HLS_DIR, 'index.m3u8');

    const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i "${concatFilePath}" -c copy -hls_time 10 -hls_list_size 0 -hls_segment_filename "${HLS_DIR}/segment_%03d.ts" "${hlsOutputPath}"`;

    await execPromise(ffmpegCmd);

    console.log('Segmentos HLS gerados.');
}

function getMediaInfo(filepath) {
    return new Promise((resolve, reject) => {
        const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,avg_frame_rate -of default=noprint_wrappers=1 "${filepath}"`;
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error('Erro ao obter informações de mídia:', error);
                return reject(error);
            }

            const info = {};
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
                const [key, value] = line.split('=');
                info[key] = value;
            }
            resolve(info);
        });
    });
}

function compareMediaInfo(info1, info2) {
    return info1.codec_name === info2.codec_name &&
        info1.width === info2.width &&
        info1.height === info2.height &&
        info1.avg_frame_rate === info2.avg_frame_rate;
}

function transcodeMediaFile(filepath) {
    return new Promise((resolve, reject) => {
        const tempFilepath = filepath + '_transcoded.mp4';
        const cmd = `ffmpeg -y -i "${filepath}" -c:v libx264 -preset veryfast -crf 23 -c:a aac -strict -2 "${tempFilepath}"`;
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error('Erro ao transcodificar arquivo de mídia:', error);
                return reject(error);
            }

            // Substitui o arquivo original pelo transcodificado
            fs.renameSync(tempFilepath, filepath);
            resolve();
        });
    });
}

function execPromise(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error('Erro ao executar comando:', error);
                return reject(error);
            }
            resolve();
        });
    });
}

// Inicia a verificação periódica
checkAndUpdatePlaylist(); // Executa imediatamente na inicialização
setInterval(checkAndUpdatePlaylist, CHECK_INTERVAL);
