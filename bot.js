/**
 * 🤖 BOT WhatsApp + LMStudio (Versão Otimizada)
 * Autor: Paula Abib
 * * Dependências (Instale com npm):
 * @whiskeysockets/baileys (última versão)
 * qrcode-terminal
 * pino
 * @hapi/boom
 * axios
 * * NOTA: Este arquivo usa CommonJS com Import Dinâmico para o Baileys.
 */

// MÓDULOS COMMONJS
// ---------------------------------------------------------------------
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// CONFIGURAÇÕES GERAIS
// ---------------------------------------------------------------------
const lmstudioUrl = 'http://127.0.0.1:1234'; // Endereço explícito do LM Studio
const historicoConversas = new Map();
const PASTA_CONHECIMENTO = path.join(__dirname, 'knowledge');

// Números autorizados (sem o '+' e sem o 9 extra se for apenas o ddd+numero)
const numerosAutorizados = [
  '5516991963240',
  '5516992482157' 
];

console.log('🤖 Bot com LMStudio iniciando...');
console.log(`📞 Números autorizados: ${numerosAutorizados.join(', ')}\n`);

// CARREGAMENTO DA BASE DE CONHECIMENTO
// ---------------------------------------------------------------------

/**
 * Carrega o conteúdo de todos os arquivos .txt da pasta 'knowledge'.
 * @returns {string} Conteúdo concatenado da base de conhecimento.
 */
function carregarBaseConhecimento() {
  console.log('📚 Carregando base de conhecimento...');
  if (!fs.existsSync(PASTA_CONHECIMENTO)) {
    fs.mkdirSync(PASTA_CONHECIMENTO, { recursive: true });
    console.log('📁 Pasta "knowledge" criada. Adicione arquivos .txt nela.');
    return '';
  }

  let conteudoCompleto = '';
  const arquivos = fs.readdirSync(PASTA_CONHECIMENTO);
  
  arquivos.forEach(arquivo => {
    // Foca apenas em .txt, ignorando o aviso ExperimentalWarning de .json
    if (arquivo.endsWith('.txt')) { 
      const caminhoArquivo = path.join(PASTA_CONHECIMENTO, arquivo);
      const conteudo = fs.readFileSync(caminhoArquivo, 'utf-8');
      conteudoCompleto += `\n=== ${arquivo} ===\n${conteudo}\n`;
    }
  });
  
  console.log(`✅ ${arquivos.length} arquivos processados na base de conhecimento.`);
  return conteudoCompleto;
}

const conteudoConhecimento = carregarBaseConhecimento();


// CONEXÃO COM O WHATSAPP
// ---------------------------------------------------------------------

async function conectarAoWhatsApp() {
    
  // 🚀 Importação Dinâmica do Baileys (Necessária para CommonJS + ESM)
  const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState 
  } = await import('@whiskeysockets/baileys');

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['LMStudio Bot', 'Chrome', '1.0'], // Nome amigável na sessão
    printQRInTerminal: true // Garante a impressão do QR no terminal
  });

  sock.ev.on('creds.update', saveCreds);

  
  // ATUALIZAÇÃO DE CONEXÃO
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    // O QR code é impresso automaticamente por 'printQRInTerminal: true',
    // mas o código antigo (if (qr)) foi mantido caso a opção seja removida.
    
    if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp com sucesso!');
      
      // Testar conexão ao LMStudio
      axios.get(`${lmstudioUrl}/v1/models`, { timeout: 5000 })
           .then(() => console.log('🧠 LMStudio online e pronto!'))
           .catch(() => console.log('⚠️ Não foi possível conectar ao LMStudio. Inicie-o manualmente.'));
           
    } else if (connection === 'close') {
      
      // Extrai o código de erro para log
      const motivo = new Boom(lastDisconnect?.error)?.output?.statusCode;
      
      console.log(`❌ Conexão fechada. Motivo: ${motivo}`);
      
      const deveReconectar = motivo !== DisconnectReason.loggedOut;

      if (deveReconectar) {
          console.log('🔄 Tentando reconectar em 3 segundos...');
          setTimeout(() => conectarAoWhatsApp(), 3000); 
      } else {
          console.log('🛑 Sessão encerrada (Logout). Apague a pasta "auth_info_baileys" para iniciar uma nova sessão.');
      }
    }
  });

  
  // RECEBENDO E PROCESSANDO MENSAGENS
  // ---------------------------------------------------------------------
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const numeroRemetente = from.split('@')[0];
    
    // Extrai o texto da mensagem
    const textoMensagem = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    console.log(`📩 Mensagem de ${numeroRemetente}: ${textoMensagem}`);
    
    // Checar autorização
    if (!numerosAutorizados.includes(numeroRemetente)) {
      console.log(`🚫 Mensagem ignorada: ${numeroRemetente} não autorizado.`);
      return;
    }

    try {
      // 1. VERIFICAR LM STUDIO
      const lmstudioOnline = await axios.get(`${lmstudioUrl}/v1/models`, { timeout: 3000 })
        .then(() => true)
        .catch(() => false);

      if (!lmstudioOnline) {
        await sock.sendMessage(from, { text: '⚠️ O LMStudio não está ativo. Abra o programa e tente novamente.' });
        return;
      }

      // 2. CONSTRUIR MENSAGENS PARA A IA
      const historico = historicoConversas.get(from) || [];
      
      let systemMessage = 'Você é um assistente útil que responde em português brasileiro. Seu nome é LMStudio Bot.';

      if (conteudoConhecimento) {
        systemMessage += '\n\nBASE DE CONHECIMENTO:\n' + conteudoConhecimento;
        systemMessage += '\nUse essa base de conhecimento apenas quando for relevante para responder ao usuário.';
      }

      const mensagensParaIA = [
        { role: 'system', content: systemMessage },
        ...historico,
        { role: 'user', content: textoMensagem }
      ];
      
      // 3. REQUISIÇÃO AO LM STUDIO
      const respostaIA = await axios.post(`${lmstudioUrl}/v1/chat/completions`, {
        model: 'local-model', // Geralmente é o 'local-model' se não for especificado no LMStudio
        messages: mensagensParaIA,
        temperature: 0.3,
        max_tokens: 300
      }, { timeout: 30000 });

      const respostaTexto = respostaIA.data.choices[0].message.content;
      
      // 4. ATUALIZAR HISTÓRICO
      historico.push({ role: 'user', content: textoMensagem });
      historico.push({ role: 'assistant', content: respostaTexto });
      // Limita o histórico a 20 mensagens (10 pares)
      if (historico.length > 20) historico.splice(0, historico.length - 20); 
      historicoConversas.set(from, historico);

      // 5. ENVIAR RESPOSTA
      await sock.sendMessage(from, { text: respostaTexto });
      console.log(`💬 IA respondeu: ${respostaTexto}`);

    } catch (error) {
      console.error('❌ Erro no processamento:', error.message);
      await sock.sendMessage(from, { text: 'Desculpe, ocorreu um erro ao tentar gerar a resposta. Por favor, tente novamente.' });
    }
  });
}

// INICIAR O BOT
// ---------------------------------------------------------------------
conectarAoWhatsApp();