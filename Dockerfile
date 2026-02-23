# Usa uma imagem base do Node (Debian-based é melhor para compatibilidade com canvas)
FROM node:20-slim

# Instala as dependências do sistema necessárias para o node-canvas e ffmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# Define o diretório de trabalho
WORKDIR /app

# Copia apenas os arquivos de dependência primeiro (para cache eficiente)
COPY package*.json ./

# Instala as dependências do Node
RUN npm install --production

# Copia o restante do código fonte
COPY . .

# Cria a pasta tmp se não existir (para garantir)
RUN mkdir -p tmp

# Comando para iniciar a aplicação
CMD ["node", "--env-file=.env", "index.js"]
