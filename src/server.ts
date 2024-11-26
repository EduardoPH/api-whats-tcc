import express from 'express';
import { Server } from 'socket.io';
import http from 'http';
import { makeWASocket, fetchLatestBaileysVersion, DisconnectReason, makeInMemoryStore, type Chat, type WASocket } from '@whiskeysockets/baileys';
import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import P from 'pino';
import NodeCache from 'node-cache';
import fs from 'fs';
import type { Boom } from '@hapi/boom';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    credentials: true,
  },
});

// Cache para gerenciar sockets e conexões
const activeSockets = new Map<string, any>();

const msgRetryCounterCache = new NodeCache();
const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'));
logger.level = 'trace';


const userStores = new Map<string, any>(); 

const createUserStore = (userId: string) => {
  if (userStores.has(userId)) {
    console.log(`Store já existe para o userId: ${userId}`);
    return userStores.get(userId);
  }

  const logger = P({ level: 'silent' });  
  const store = makeInMemoryStore({ logger });

  const storeFilePath = `./store_${userId}.json`;
  store.readFromFile(storeFilePath);
  setInterval(() => {
    store.writeToFile(storeFilePath);
  }, 10_000);

  userStores.set(userId, store); 
  console.log(`Novo store criado para o userId: ${userId}`);
  return store;
};

// Função para obter o store de um userId
const getUserStore = (userId: string) => {
  return userStores.get(userId);
};

io.on('connection', async (client) => {
  console.log(`Cliente conectado: ${client.id}`);

  if (activeSockets.has(client.id)) {
    console.log(`Cliente ${client.id} já está conectado. Ignorando nova conexão.`);
    return;
  }

  let baileysInstance: WASocket;

  const connectWhatsApp = async (userId: string) => {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(`multi_auth_info_${userId}`);
      const { version } = await fetchLatestBaileysVersion();
  
      const socket = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        generateHighQualityLinkPreview: true,
        qrTimeout: 60000,
        msgRetryCounterCache
      }); 
  
      socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
  
        if (qr) {
          console.log('QR Code recebido:', qr);
          client.emit('qr', qr);
        }
  
        if (connection === 'close') {
          console.log(`Conexão fechada para ${userId}.`);
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
  
          // Verifica se o userId ainda está ativo antes de tentar reconectar
          if (!activeSockets.has(userId)) {
            console.log(`Reconexão abortada para ${userId}, pois o cliente foi desconectado.`);
            return;
          }
  
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          if (shouldReconnect) {
            console.log('Tentando reconectar...');
            await connectWhatsApp(userId);
          } else {
            console.log(`Credenciais inválidas para ${userId}. Apagando dados...`);
            const path = `multi_auth_info_${userId}`;
            if (fs.existsSync(path)) {
              fs.rmSync(path, { recursive: true, force: true });
              console.log(`Dados de autenticação de ${userId} removidos.`);
              activeSockets.delete(userId);
              client.emit('status', 'disconnected');
            }
          }
        }
  
        if (connection === 'open') {
          console.log(`Conexão aberta para ${userId}.`);
          client.emit('status', 'connected');
          const store = createUserStore(userId);
          const groups = await socket.groupFetchAllParticipating();
          const groupArray = Object.values(groups);
          const chats: Chat[] = groupArray.map((group) => ({
            id: group.id,
            name: group.subject,
            participants: group.participants,
            conversationTimestamp: group.creation,
            unreadCount: 0,
            messages: [],
          }));
  
          chats.forEach((chat) => {
            if (!store.chats.get(chat.id)) {
              store.chats.insert(chat);
              console.log(`Grupo inserido no store: ${chat.id}`);
            }
          });
          console.log('Grupos armazenados no store:', groupArray.length);
        }
      });
  
      socket.ev.on('creds.update', saveCreds);
  
      return socket;
    } catch (error) {
      console.error('Erro ao conectar ao WhatsApp:', error);
      throw error;
    }
  };
  

  // Escutar eventos do cliente
  client.on('auth', async (data) => {
    const { userId } = data;
    console.log(`Autenticação solicitada para ${userId}.`);

    if (!userId) {
      client.emit('error', 'UserId não fornecido.');
      return;
    }

    const existingConnection = activeSockets.get(userId);
    if (existingConnection) {
      console.log(`Já existe uma conexão ativa para o userId ${userId}.`);
      client.emit('status', 'already_connected');
      return;
    }

    try {
      // Inicia a conexão com o WhatsApp
      baileysInstance = await connectWhatsApp(userId);
      activeSockets.set(userId, { clientId: client.id, baileysInstance });
    } catch (error) {
      console.error('Erro na autenticação:', error);
      client.emit('error', 'Erro ao conectar ao WhatsApp.');
    }


    baileysInstance.ev.on('messages.upsert', async (message) => {
      console.log('Mensagem recebida:', message);
      client.emit('message', message);
    })

    client.on('disconnect', () => {
      console.log(`Cliente desconectado: ${client.id}`);
    
      const userConnection = activeSockets.get(userId);
    
      if (userConnection && userConnection.clientId === client.id) {
        console.log(`Encerrando conexão do userId: ${userId}`);
        activeSockets.delete(userId); // Remove o userId do activeSockets
    
        // Encerrar o servidor WhatsApp
        if (baileysInstance) {
          baileysInstance.ev.removeAllListeners(undefined); // Remove todos os listeners para evitar reconexão
          baileysInstance.ws.close(); // Fecha a conexão WebSocket
          console.log(`Servidor WhatsApp para ${userId} foi encerrado.`);
        }
      }
    });
    

    client.on('listGroups', async () => {
      try {
        // Garante que o store está atualizado
        const allChats = getUserStore(userId).chats.all();
  
        // Filtra os grupos
        const groups: Chat[] = allChats.filter(chat => chat.id.endsWith('@g.us'));
        console.error('Erro ao listar os grupos:', groups);
  
        // Emite os grupos para o cliente
        client.emit('groups', groups);
      } catch (error) {
        console.error('Erro ao listar os grupos:', error);
      }
    });

  });

  client.on('sendMessage', async (data) => {
    const { groupId, message } = data;

    if (!baileysInstance) {
      client.emit('error', 'Você não está conectado.');
      return;
    }

    try {
      console.log(`Enviando mensagem para ${groupId}: ${message}`);
      await baileysInstance.sendMessage(groupId, { text: message });
      client.emit('messageStatus', { status: 'sent' });
    } catch (error) {
      console.error('Erro ao enviar mensagem:', error);
      client.emit('error', 'Erro ao enviar mensagem.');
    }
  });

  
});

// Porta do servidor
const PORT = 3030;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
