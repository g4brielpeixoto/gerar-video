# Gerador de Vídeos Bíblicos

Este projeto automatiza a criação de vídeos verticais (9:16) contendo versículos bíblicos. Ele utiliza o `Canvas` para renderização de texto de alta qualidade e integração com serviços de narração.

## Configuração e Instalação

### 1. Dependências do Sistema (Necessárias para o `canvas`)

#### Ubuntu/Debian:
```bash
sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
```

#### macOS:
```bash
brew install pkg-config cairo pango libpng jpeg giflib librsvg pixman
```

#### Windows:
Siga as instruções de instalação do [node-canvas](https://github.com/Automattic/node-canvas/wiki/Installation:-Windows).

### 2. Instalação do Projeto

```bash
# Clone o repositório e instale as dependências do Node.js
npm install
```

### 3. Execução

Certifique-se de configurar seu arquivo `.env` com as chaves necessárias e execute:

```bash
node --env-file=.env index.js
```
