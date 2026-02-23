import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { createCanvas } from 'canvas';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import 'dotenv/config';

// =======================
// CONFIG
// =======================

const S3_BUCKET = process.env.S3_BUCKET_NAME;
const S3_REGION = process.env.AWS_REGION || 'us-east-1';
const S3_STATE_KEY = 'biblia/state.json';
const S3_VIDEOS_PRONTOS_DIR = 'biblia/videos/prontos/';

const s3Client = new S3Client({
  region: S3_REGION,
});

const STATE_FILE = './state.json';
const TMP_DIR = './tmp';
const OUTPUT_DIR = './output';
const BIBLE_FILE = './nvi.json';

const VOICE_ID = 'CwhRBWXzGAHq8TQ4Fs17';
const MODEL_ID = 'eleven_multilingual_v2';

// Pausas em segundos
const PAUSA_INICIAL = 0.5;
const PAUSA_FINAL = 1.0;

// Dimensões do vídeo (vertical - 9:16)
const VIDEO_WIDTH = 1080;
const VIDEO_HEIGHT = 1920;

// Margens de Segurança (Sociais) - Relativas a 1080x1920 (escaladas de 850x1512)
const SAFE_TOP = Math.round(VIDEO_HEIGHT * (108 / 1512));    // ~137
const SAFE_LEFT = Math.round(VIDEO_WIDTH * (60 / 850));      // ~76
const SAFE_RIGHT = Math.round(VIDEO_WIDTH * (120 / 850));    // ~152
const SAFE_BOTTOM = Math.round(VIDEO_HEIGHT * (320 / 1512)); // ~406

// Configurações de texto
const FONT_SIZE = 52;
const LINE_HEIGHT = 72;
const TEXT_COLOR = '#FFFFFF';
const MAX_WIDTH = VIDEO_WIDTH - SAFE_LEFT - SAFE_RIGHT;

// Configurações do título
const TITLE_FONT_SIZE = 64; // Um pouco maior
const TITLE_SPACING = 80;

// =======================
// SETUP
// =======================

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

function getApiKeys() {
  const keys = [];
  if (process.env.ELEVENLABS_API_KEY) keys.push(process.env.ELEVENLABS_API_KEY);
  
  let i = 1;
  while (process.env[`ELEVENLABS_API_KEY${i}`]) {
    keys.push(process.env[`ELEVENLABS_API_KEY${i}`]);
    i++;
  }
  return keys;
}

const API_KEYS = getApiKeys();
if (API_KEYS.length === 0) {
  console.error('❌ Nenhuma ELEVENLABS_API_KEY encontrada no .env');
  process.exit(1);
}

let currentApiKeyIndex = 0;
let elevenlabs;

async function initElevenLabs(index) {
  currentApiKeyIndex = index;
  console.log(`🔑 Usando API Key #${currentApiKeyIndex}`);
  elevenlabs = new ElevenLabsClient({
    apiKey: API_KEYS[currentApiKeyIndex],
  });
}

async function rotateApiKey() {
  currentApiKeyIndex++;
  if (currentApiKeyIndex >= API_KEYS.length) {
    throw new Error('❌ Todas as chaves de API foram esgotadas.');
  }
  
  console.log(`🔄 Trocando para API Key reserva #${currentApiKeyIndex}...`);
  await initElevenLabs(currentApiKeyIndex);

  const state = await loadState();
  state.apiKeyIndex = currentApiKeyIndex;
  await saveState(state);
}

async function ensureQuota(textLength) {
  try {
    const subscription = await elevenlabs.user.getSubscriptionInfo();
    const remaining = subscription.character_limit - subscription.character_count;
    
    if (remaining < textLength) {
      console.log(`⚠️ Saldo insuficiente na chave #${currentApiKeyIndex} (${remaining} caracteres restantes).`);
      await rotateApiKey();
      return await ensureQuota(textLength); 
    }
  } catch (err) {
    console.error(`❌ Erro ao verificar quota da chave #${currentApiKeyIndex}:`, err.message);
    await rotateApiKey();
    return await ensureQuota(textLength);
  }
}

async function uploadVideoToS3(localPath, filename) {
  console.log(`⬆️ Enviando para S3: ${S3_VIDEOS_PRONTOS_DIR}${filename}`);
  const fileStream = fs.createReadStream(localPath);
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: `${S3_VIDEOS_PRONTOS_DIR}${filename}`,
    Body: fileStream,
    ContentType: 'video/mp4',
  }));
}

// =======================
// LOAD BIBLE
// =======================

let bible;
try {
  const raw = fs.readFileSync(BIBLE_FILE, 'utf8').replace(/^\uFEFF/, '');
  bible = JSON.parse(raw);
} catch (err) {
  console.error('❌ Erro ao carregar nvi.json');
  process.exit(1);
}

// =======================
// STATE
// =======================

async function loadState() {
  try {
    const data = await s3Client.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: S3_STATE_KEY,
    }));
    const bodyContents = await data.Body.transformToString();
    const state = JSON.parse(bodyContents);
    return { 
      book: state.book || 0, 
      chapter: state.chapter || 0,
      apiKeyIndex: state.apiKeyIndex || 0
    };
  } catch (err) {
    if (err.name === 'NoSuchKey') {
      console.log('ℹ️ state.json não encontrado no S3, iniciando do zero.');
      return { book: 0, chapter: 0, apiKeyIndex: 0 };
    }
    console.error('❌ Erro ao carregar estado do S3:', err.message);
    // Fallback para local se houver erro de rede/credenciais e o arquivo existir
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    return { book: 0, chapter: 0, apiKeyIndex: 0 };
  }
}

async function saveState(state) {
  try {
    // Salva localmente como backup
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    
    // Salva no S3
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: S3_STATE_KEY,
      Body: JSON.stringify(state, null, 2),
      ContentType: 'application/json',
    }));
  } catch (err) {
    console.error('❌ Erro ao salvar estado no S3:', err.message);
  }
}

// =======================
// GET NEXT CHAPTER
// =======================

function getNextChapter(state) {
  if (state.book >= bible.length) {
    console.log('📕 Bíblia finalizada');
    process.exit(0);
  }

  const book = bible[state.book];
  const verses = book.chapters[state.chapter];
  
  const chapterInfo = {
    bookIndex: state.book,
    chapterIndex: state.chapter,
    bookName: book.name,
    chapterNumber: state.chapter + 1,
    verses: verses
  };

  return chapterInfo;
}

async function advanceState(chapterInfo, currentApiKeyIndex) {
  const state = { 
    book: chapterInfo.bookIndex, 
    chapter: chapterInfo.chapterIndex,
    apiKeyIndex: currentApiKeyIndex 
  };
  
  const book = bible[state.book];
  state.chapter++;
  if (state.chapter >= book.chapters.length) {
    state.chapter = 0;
    state.book++;
  }

  await saveState(state);
}

// =======================
// TEXT WRAPPING
// =======================

function wrapTextCanvas(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine + (currentLine ? ' ' : '') + word;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && currentLine !== '') {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

// =======================
// SPLIT INTO SLIDES
// =======================

function splitIntoSlides(chapterInfo) {
  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.font = `${FONT_SIZE}px Arial, sans-serif`;

  const slides = [];
  let currentDisplayVerses = [];
  let currentReadVerses = [];
  
  // O título agora é fixo para todos os slides conforme solicitado
  const titleText = `${chapterInfo.bookName} ${chapterInfo.chapterNumber}`;

  for (let i = 0; i < chapterInfo.verses.length; i++) {
    const verseNum = i + 1;
    const verseText = chapterInfo.verses[i];
    const displayVerse = `(${verseNum}) ${verseText}`;
    
    // Testar se cabe na tela respeitando as margens
    const testDisplayVerses = [...currentDisplayVerses, displayVerse];
    const fullDisplayText = testDisplayVerses.join(' ');
    const lines = wrapTextCanvas(ctx, fullDisplayText, MAX_WIDTH);
    
    const textHeight = lines.length * LINE_HEIGHT;
    const availableHeight = VIDEO_HEIGHT - SAFE_TOP - SAFE_BOTTOM - TITLE_FONT_SIZE - TITLE_SPACING;
    
    if (textHeight > availableHeight && currentDisplayVerses.length > 0) {
      slides.push({
        title: titleText,
        textToDisplay: currentDisplayVerses.join(' '),
        textToRead: currentReadVerses.join(' ')
      });
      currentDisplayVerses = [displayVerse];
      currentReadVerses = [verseText];
    } else {
      currentDisplayVerses.push(displayVerse);
      currentReadVerses.push(verseText);
    }
  }

  if (currentDisplayVerses.length > 0) {
    slides.push({
      title: titleText,
      textToDisplay: currentDisplayVerses.join(' '),
      textToRead: currentReadVerses.join(' ')
    });
  }

  return slides;
}

// =======================
// IMAGEM
// =======================

function gerarImagemSlide(slide, index) {
  const canvas = createCanvas(VIDEO_WIDTH, VIDEO_HEIGHT);
  const ctx = canvas.getContext('2d');

  // Fundo preto
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

  // Título: Esquerda, Negrito, Maior
  ctx.font = `bold ${TITLE_FONT_SIZE}px Arial, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#FFD700'; // Mantendo dourado para destaque
  ctx.fillText(slide.title, SAFE_LEFT, SAFE_TOP);
  
  // Texto Principal
  ctx.font = `${FONT_SIZE}px Arial, sans-serif`;
  const lines = wrapTextCanvas(ctx, slide.textToDisplay, MAX_WIDTH);
  
  let y = SAFE_TOP + TITLE_FONT_SIZE + TITLE_SPACING;
  ctx.fillStyle = TEXT_COLOR;
  
  for (const line of lines) {
    ctx.fillText(line, SAFE_LEFT, y);
    y += LINE_HEIGHT;
  }

  const imagePath = path.join(TMP_DIR, `slide_${index}.png`);
  fs.writeFileSync(imagePath, canvas.toBuffer('image/png'));
  return imagePath;
}

// =======================
// AUDIO
// =======================

async function gerarAudioSlide(text, index) {
  const audioNarracaoPath = path.join(TMP_DIR, `raw_${index}.mp3`);
  const audioFinalPath = path.join(TMP_DIR, `audio_${index}.mp3`);

  // Verificar se temos quota na chave atual
  await ensureQuota(text.length);

  const audioStream = await elevenlabs.textToSpeech.convert(VOICE_ID, {
    text: text,
    modelId: MODEL_ID,
    outputFormat: 'mp3_44100_128',
  });

  const writeStream = fs.createWriteStream(audioNarracaoPath);
  for await (const chunk of audioStream) {
    writeStream.write(chunk);
  }
  writeStream.end();
  await new Promise(resolve => writeStream.on('finish', resolve));

  // Adicionar silêncio
  const silIni = path.join(TMP_DIR, `sil_ini_${index}.mp3`);
  const silFin = path.join(TMP_DIR, `sil_fin_${index}.mp3`);
  
  execSync(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${PAUSA_INICIAL} -q:a 9 "${silIni}"`, { stdio: 'ignore' });
  execSync(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${PAUSA_FINAL} -q:a 9 "${silFin}"`, { stdio: 'ignore' });

  const listFile = path.join(TMP_DIR, `list_${index}.txt`);
  fs.writeFileSync(listFile, `file '${path.resolve(silIni)}'\nfile '${path.resolve(audioNarracaoPath)}'\nfile '${path.resolve(silFin)}'`);
  
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${audioFinalPath}"`, { stdio: 'ignore' });

  // Limpar subs
  fs.unlinkSync(audioNarracaoPath);
  fs.unlinkSync(silIni);
  fs.unlinkSync(silFin);
  fs.unlinkSync(listFile);

  return audioFinalPath;
}

function getAudioDuration(audioPath) {
  const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`);
  return parseFloat(out.toString());
}

// =======================
// MAIN
// =======================

async function main() {
  // Limpar TMP no início
  if (fs.existsSync(TMP_DIR)) {
    fs.readdirSync(TMP_DIR).forEach(f => fs.unlinkSync(path.join(TMP_DIR, f)));
  }

  const state = await loadState();
  await initElevenLabs(state.apiKeyIndex || 0);

  const chapterInfo = getNextChapter(state);
  console.log(`📖 Processando: ${chapterInfo.bookName} ${chapterInfo.chapterNumber}`);

  const slides = splitIntoSlides(chapterInfo);
  console.log(`📑 Slides gerados: ${slides.length}`);

  const imagePaths = [];
  const audioPaths = [];
  const durations = [];

  for (let i = 0; i < slides.length; i++) {
    console.log(`  ⏳ Processando slide ${i + 1}/${slides.length}...`);
    
    const imgPath = gerarImagemSlide(slides[i], i);
    
    // No primeiro slide, narramos o Título + Texto. Nos outros, apenas o Texto.
    // O texto a ser lido não contém os números dos versículos.
    const textoParaNarrar = i === 0 
      ? `${slides[i].title}. ${slides[i].textToRead}`
      : slides[i].textToRead;

    const audPath = await gerarAudioSlide(textoParaNarrar, i);
    const duration = getAudioDuration(audPath);
    
    imagePaths.push(imgPath);
    audioPaths.push(audPath);
    durations.push(duration);
  }

  // Concatenar Audios
  console.log('🎤 Concatenando áudios...');
  const finalAudioPath = path.join(TMP_DIR, 'final_audio.mp3');
  const audioListFile = path.join(TMP_DIR, 'audio_list.txt');
  fs.writeFileSync(audioListFile, audioPaths.map(p => `file '${path.resolve(p)}'`).join('\n'));
  execSync(`ffmpeg -y -f concat -safe 0 -i "${audioListFile}" -c copy "${finalAudioPath}"`, { stdio: 'ignore' });

  // Criar lista de imagens para FFmpeg
  console.log('🎬 Gerando vídeo final...');
  const imageListFile = path.join(TMP_DIR, 'image_list.txt');
  let imageListContent = '';
  for (let i = 0; i < imagePaths.length; i++) {
    imageListContent += `file '${path.resolve(imagePaths[i])}'\nduration ${durations[i]}\n`;
  }
  // FFmpeg concat demuxer bug: o último arquivo deve aparecer duas vezes (uma sem duração) ou ter uma duração explícita
  imageListContent += `file '${path.resolve(imagePaths[imagePaths.length - 1])}'\n`;
  fs.writeFileSync(imageListFile, imageListContent);

  const outputFilename = `${chapterInfo.bookName}_${chapterInfo.chapterNumber}_${Date.now()}.mp4`.replace(/\s+/g, '_');
  const outputPath = path.join(OUTPUT_DIR, outputFilename);

  // Comando FFmpeg final
  const cmd = `ffmpeg -y -f concat -safe 0 -i "${imageListFile}" -i "${finalAudioPath}" -c:v libx264 -pix_fmt yuv420p -r 30 -c:a aac -b:a 192k -shortest "${outputPath}"`;
  execSync(cmd, { stdio: 'inherit' });

  console.log(`✅ Vídeo concluído localmente: ${outputPath}`);

  // Upload para S3
  await uploadVideoToS3(outputPath, outputFilename);

  // Avançar estado apenas se concluído com sucesso
  await advanceState(chapterInfo, currentApiKeyIndex);

  // Limpar TMP
  if (fs.existsSync(TMP_DIR)) {
    fs.readdirSync(TMP_DIR).forEach(f => fs.unlinkSync(path.join(TMP_DIR, f)));
  }
}

main().catch(err => {
  console.error('❌ Erro fatal:', err);
});
