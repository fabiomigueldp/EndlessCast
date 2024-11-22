const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const mkdirp = require('mkdirp');
const crypto = require('crypto');

let lastJSONHash = null;
let isProcessing = false;

// Função para buscar o JSON
async function fetchJSON(url) {
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error(`Erro ao buscar JSON: ${error}`);
        return null;
    }
}

// Função para gerar um hash do JSON
function hashJSON(json) {
    const jsonString = JSON.stringify(json);
    return crypto.createHash('md5').update(jsonString).digest('hex');
}

// Função para baixar os arquivos de mídia
async function downloadMediaFiles(mediaFiles, downloadDir) {
    for (const media of mediaFiles) {
        const mediaUrl = media.media_url;
        const fileName = path.basename(mediaUrl);
        const filePath = path.join(downloadDir, fileName);
        if (!fs.existsSync(filePath)) {
            console.log(`Baixando ${mediaUrl}...`);
            const writer = fs.createWriteStream(filePath);
            const response = await axios({
                url: mediaUrl,
                method: 'GET',
                responseType: 'stream'
            });
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
        } else {
            console.log(`Arquivo ${fileName} já existe. Pulando download.`);
        }
    }
}

// Função para processar os arquivos de mídia em segmentos DASH
async function processMediaFiles(mediaFiles, originalDir, dashDir) {
    for (const media of mediaFiles) {
        const fileName = path.basename(media.media_url);
        const inputFile = path.join(originalDir, fileName);
        const outputDir = path.join(dashDir, path.parse(fileName).name);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        const mpdFile = path.join(outputDir, 'manifest.mpd');
        if (!fs.existsSync(mpdFile)) {
            console.log(`Processando ${inputFile} para DASH...`);
            await processFileToDASH(inputFile, outputDir);
        } else {
            console.log(`Arquivo DASH para ${fileName} já existe. Pulando processamento.`);
        }
    }
}

// Função para processar um único arquivo em DASH usando ffmpeg
async function processFileToDASH(inputFile, outputDir) {
    return new Promise((resolve, reject) => {
        // Executa o ffprobe para obter informações do vídeo
        exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,bit_rate -of json "${inputFile}"`, (err, stdout, stderr) => {
            if (err) {
                console.error(`Erro ao executar ffprobe: ${err}`);
                return reject(err);
            }
            const videoInfo = JSON.parse(stdout);
            const { width, height, bit_rate } = videoInfo.streams[0];

            // Baseado nas informações, define parâmetros de codificação
            const cmd = `ffmpeg -i "${inputFile}" -map 0 -codec:v libx264 -codec:a aac -f dash -min_seg_duration 2000000 -use_template 1 -use_timeline 1 "${outputDir}/manifest.mpd"`;
            exec(cmd, (err, stdout, stderr) => {
                if (err) {
                    console.error(`Erro ao executar ffmpeg: ${err}`);
                    return reject(err);
                }
                console.log(`Processamento de ${inputFile} concluído.`);
                resolve();
            });
        });
    });
}

// Função principal
async function main() {
    if (isProcessing) {
        console.log('Processamento em andamento. Aguardando próxima execução.');
        return;
    }
    isProcessing = true;

    const url = 'https://markup.uguu.io/example_prada.json';
    const playlistsDir = path.join(__dirname, 'playlists');
    const playlistName = path.parse(url).name;
    const playlistDir = path.join(playlistsDir, playlistName);
    const originalDir = path.join(playlistDir, 'original');
    const dashDir = path.join(playlistDir, 'dash');

    // Garante que os diretórios existam
    mkdirp.sync(originalDir);
    mkdirp.sync(dashDir);

    // Busca o JSON
    const json = await fetchJSON(url);
    if (!json) {
        isProcessing = false;
        return;
    }

    // Verifica se o JSON mudou
    const currentJSONHash = hashJSON(json);
    if (currentJSONHash === lastJSONHash) {
        console.log('JSON não mudou. Nenhuma ação necessária.');
        isProcessing = false;
        return;
    }

    lastJSONHash = currentJSONHash;

    const mediaFiles = json.media_files;

    // Baixa os arquivos de mídia
    await downloadMediaFiles(mediaFiles, originalDir);

    // Processa os arquivos de mídia em DASH
    await processMediaFiles(mediaFiles, originalDir, dashDir);

    isProcessing = false;
}

// Executa a função principal a cada 1 minuto
setInterval(main, 60000);
main();

