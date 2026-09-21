# ADIPRO — Login con aprobación por Telegram

El usuario ingresa **solo su cédula**. La solicitud llega a tu grupo de operadores en
Telegram, un asesor toca **✅ Aprobar** o **⛔ Rechazar**, y la pantalla del usuario
muestra el resultado. **Nunca se envían ni almacenan contraseñas.**

## Qué se envía a Telegram
- La cédula ingresada + la hora.
- Nada más. No hay campo de contraseña.

## Puesta en marcha
1. **Revoca el token viejo** en [@BotFather](https://t.me/BotFather) → `/revoke`, y crea uno nuevo.
2. Copia la configuración:
   ```bash
   cp .env.example .env
   ```
   Rellena `TELEGRAM_BOT_TOKEN` (el nuevo) y `TELEGRAM_OPERATORS_CHAT_ID`.
3. Instala y arranca:
   ```bash
   npm install
   npm start
   ```
4. Abre http://localhost:3000

> El bot debe estar **dentro del grupo** de operadores para poder escribir ahí.
> Para grupos, el chat id suele empezar por `-100`. Si no lo sabes, agrega el bot al
> grupo, envía un mensaje y consulta `https://api.telegram.org/bot<TOKEN>/getUpdates`.

## Flujo
```
Cédula → POST /api/login-request → mensaje al grupo con botones
       → operador decide → GET /api/status/:id (polling) → Aprobado / Rechazado
```

## Notas de seguridad
- El token del bot vive solo en el servidor (`.env`), jamás en el navegador.
- El estado está en memoria (se pierde al reiniciar). Para producción usa Redis o una BD.
- Considera limitar reintentos y validar el origen de las peticiones antes de exponerlo.
- Si esta pantalla representa a una marca, usa **tu propia** identidad; no imites a terceros.
