# Despliegue en DigitalOcean

Guía para montar **todo** XpressApp 2.0 en un solo Droplet de DigitalOcean,
dimensionado para **poco tráfico**. Cubre la arquitectura, los archivos de
despliegue del repo, y el paso a paso.

> Para desarrollo local, ver [CORRER-EN-LOCAL.md](CORRER-EN-LOCAL.md).

---

## 1. Arquitectura

Un único Droplet con Docker Compose corriendo 4 contenedores. Los frontends se
compilan como estáticos y los sirve Caddy, que además hace de reverse proxy
hacia la API y resuelve HTTPS automáticamente.

```
┌──────────────────────── Droplet (Ubuntu + Docker) ────────────────────────┐
│                                                                            │
│   caddy  (80/443)  ── HTTPS automático (Let's Encrypt) + reverse proxy     │
│     ├── tudominio.com            → estáticos: marketing (landing)          │
│     ├── app.tudominio.com        → estáticos: web (consola admin)          │
│     ├── portal.tudominio.com     → estáticos: portal (PWA)                 │
│     ├── *.tudominio.com          → estáticos: tenant-site (white-label)    │
│     └── /api/*  (en todos)       → reverse_proxy → api:3000                │
│                                                                            │
│   api    (NestJS + Chromium)   ← no publica puertos; solo Caddy lo ve      │
│   postgres:16   (volumen pgdata)                                           │
│   redis:7       (volumen redisdata, appendonly)                            │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

Routing (OSRM/VROOM): NO se self-hostea al inicio. ROUTING_PROVIDER=local_greedy
o un VROOM cloud. Se migra a un Droplet aparte cuando el volumen lo justifique.
```

**Por qué un Droplet y no App Platform:** la API usa **Puppeteer/Chromium**
(PDFs de cotización y FUEC), que en App Platform requiere un buildpack especial;
en Docker es trivial. Y para poco tráfico un Droplet cuesta ~$24/mes contra
~$50–60/mes de la vía gestionada.

### Componentes del proyecto

| Componente        | Qué es                                   | Despliegue         |
|-------------------|------------------------------------------|--------------------|
| `apps/marketing`  | Landing pública (React+Vite)             | Estático (Caddy)   |
| `apps/web`        | Consola administrativa (React+Vite)      | Estático (Caddy)   |
| `apps/portal`     | PWA operadores (Vite + Workbox)          | Estático (Caddy)   |
| `apps/tenant-site`| Landing white-label por tenant           | Estático (Caddy)   |
| `apps/api`        | **NestJS** — API, colas, PDFs            | Contenedor Node    |
| PostgreSQL 16     | Datos (Drizzle ORM + RLS)                | Contenedor         |
| Redis 7           | Colas BullMQ, cache, rate-limit          | Contenedor         |

---

## 2. Dimensionamiento y costo

| Recurso                       | Recomendado (poco tráfico) | Costo aprox. |
|-------------------------------|----------------------------|--------------|
| Droplet **4 GB / 2 vCPU**     | Chromium+PG+Redis juntos   | ~$24/mes     |
| Spaces (adjuntos, backups)    | Opcional                   | ~$5/mes      |
| **Total**                     |                            | **~$24–29/mes** |

> **No bajes de 4 GB.** Chromium arrancando junto a Postgres y Redis se ahoga en
> 2 GB. Si el presupuesto obliga a 2 GB, añade **swap** (ver §8).

**Alternativa gestionada** (si no quieres administrar el servidor): App Platform
para API+estáticos + Managed PostgreSQL (~$15) + Managed Redis (~$15). Más caro,
pero con backups y actualizaciones gestionadas.

---

## 3. Archivos de despliegue (ya en el repo)

| Archivo                                | Rol                                             |
|----------------------------------------|-------------------------------------------------|
| `docker/api.Dockerfile`                | Imagen de la API con Chromium                   |
| `docker/docker-compose.prod.yml`       | Stack: caddy + api + postgres + redis           |
| `docker/Caddyfile`                     | Reverse proxy + HTTPS + ruteo por subdominio    |
| `docker/.env.prod.example`             | Plantilla de secretos de producción             |

---

## 4. Requisitos previos

1. **Droplet** Ubuntu 22.04/24.04 con Docker y el plugin compose:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
2. **DNS** apuntando al IP del Droplet. Necesitas registros A para:
   - `tudominio.com` y `www`
   - `app`, `portal`
   - `*` (**wildcard**, para los subdominios de tenant) → mismo IP
3. Puertos **80** y **443** abiertos en el firewall del Droplet.

---

## 5. Configurar el entorno

En el Droplet, clona el repo y crea el `.env.prod`:

```bash
git clone <tu-repo> xpressapp-v2 && cd xpressapp-v2
cp docker/.env.prod.example docker/.env.prod
nano docker/.env.prod        # rellena TODOS los secretos
```

Genera secretos fuertes para los JWT y el cifrado de integraciones:

```bash
openssl rand -base64 48      # repite para cada *_SECRET / SECRET_KEY
```

> `DB_APP_USER` (rol de la app) **no** es superusuario: así aplica RLS. El rol
> OWNER (`POSTGRES_USER`) es solo para migraciones/ETL. El seed/migración crea el
> rol de app; ver §6.

---

## 6. Base de datos: migrar y sembrar

La API **no** corre migraciones al arrancar. Se ejecutan una vez, apuntando al
Postgres del contenedor. Levanta primero solo la BD:

```bash
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.prod \
  up -d postgres redis
```

Desde el host (con Node 20 + pnpm), apuntando `DATABASE_URL_MIGRATOR` al Postgres
publicado, corre migraciones + seed (ver comandos en
[CORRER-EN-LOCAL.md](CORRER-EN-LOCAL.md) §4). Alternativamente, ejecútalas dentro
de un contenedor efímero de la imagen de la API.

> **Cambia las contraseñas por defecto del seed** (`admin@countryexpress.com`,
> `superadmin@xpressapp.com`) inmediatamente después del primer login.

---

## 7. Compilar estáticos y levantar el stack

Los 4 frontends se compilan (en el host o en CI) y se copian a `docker/static/`,
que Caddy monta como `/srv`:

```bash
pnpm install --frozen-lockfile
pnpm build:packages
pnpm --filter @xpressapp/marketing --filter @xpressapp/web \
     --filter @xpressapp/portal --filter @xpressapp/tenant-site build

mkdir -p docker/static
cp -r apps/marketing/dist   docker/static/marketing
cp -r apps/web/dist         docker/static/web
cp -r apps/portal/dist      docker/static/portal
cp -r apps/tenant-site/dist docker/static/tenant-site

# Deck comercial (sitio estático exportado de Stitch, sin build): se copia tal cual.
cp -r apps/deck             docker/static/deck
```

### Deck comercial protegido (`deck.<dominio>`)

El deck (`apps/deck`) se sirve en `deck.<dominio>` con **login por formulario**
(pantalla de marca, no el diálogo nativo de Basic Auth). Caddy protege el
subdominio con `forward_auth` → la API valida una cookie de sesión firmada
(`GET /api/deck/check`) y, sin sesión, redirige a `/login.html`. Las credenciales
viven en la **API** (no en Caddy). Créalas antes de levantar:

```bash
cp docker/deck.env.example docker/deck.env
# Edita docker/deck.env:
#   DECK_USER=xpressapp
#   DECK_PASSWORD=<clave en texto plano>
#   DECK_AUTH_SECRET=<aleatorio>   ->  openssl rand -base64 48
```

`docker/deck.env` se pasa al contenedor de la **api** vía `env_file` (valor
literal, sin interpolación de compose). El subdominio `deck` ya está en
`PLATFORM_SUBDOMAINS` (tls-check), así que el certificado on-demand se emite solo.

> Los frontends deben apuntar sus llamadas a `/api` (mismo origen), de modo que
> Caddy las enrute a la API. Si algún build usa una URL absoluta de API, fíjala
> por variable de entorno de Vite antes de compilar.

Levanta todo (construye la imagen de la API la primera vez):

```bash
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.prod \
  up -d --build
```

Verifica:

```bash
docker compose -f docker/docker-compose.prod.yml ps
curl -fsS https://app.tudominio.com/api/health/ready
```

### TLS wildcard por tenant y subdominios de plataforma

El `Caddyfile` usa **TLS on-demand** para los subdominios (`*.tudominio.com`, más
`app`/`portal`/`deck`) con una consulta `ask` a
`http://api:3000/api/health/tls-check`. Ese endpoint **ya existe** en la API
(`apps/api/src/modules/health/health.controller.ts`): autoriza el apex, los
subdominios de plataforma de la lista `PLATFORM_SUBDOMAINS`
(`www`, `app`, `portal`, `api`, `acme-challenge`, `deck`) y los subdominios cuyo
slug corresponde a un tenant real en la BD. Cualquier otro host recibe 403 y no se
emite certificado.

> **Para añadir un nuevo subdominio de plataforma** (no-tenant), agrégalo a
> `PLATFORM_SUBDOMAINS` en ese controller y crea su bloque en el `Caddyfile`; si no,
> el handshake TLS fallará con "no certificate available".

El dominio raíz obtiene su certificado por ACME gestionado sin pasar por el `ask`.

---

## 8. Operación

**Backups de Postgres** (cron diario a Spaces, o al menos local):

```bash
docker compose -f docker/docker-compose.prod.yml exec -T postgres \
  pg_dump -U xpressapp_owner xpressapp | gzip > backup-$(date +%F).sql.gz
```

**Actualizar** tras un `git pull`: recompila estáticos (§7) y reconstruye la API:

```bash
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.prod \
  up -d --build api caddy
```

**Logs:**

```bash
docker compose -f docker/docker-compose.prod.yml logs -f api
docker compose -f docker/docker-compose.prod.yml logs -f caddy
```

**Swap** (si vas con 2 GB, no recomendado):

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## 9. Solución de problemas

| Síntoma | Causa / solución |
|---------|------------------|
| `502 Bad Gateway` en `/api` | La API no está healthy. `docker compose logs api`; revisa `DATABASE_URL`/`REDIS_URL`. |
| PDFs fallan / timeout al generar cotización o FUEC | Faltan libs de Chromium o RAM. Confirma que usas `api.Dockerfile` (trae las libs) y que el Droplet tiene ≥4 GB. |
| Certificado no emite en subdominio de tenant | El `ask` de on-demand TLS apunta a un endpoint inexistente. Ver §7 (opción A o B). |
| `TENANT_REQUIRED` al hacer login | La petición no llega por subdominio de tenant ni con header `X-Tenant`. Revisa DNS del subdominio. |
| BullMQ no procesa jobs | Redis caído o `REDIS_URL` mal. `docker compose ps redis`. |
| RLS deja ver datos de otros tenants | La app se conectó con el rol OWNER. `DATABASE_URL` debe usar `DB_APP_USER` (no superusuario). |

---

## 10. Cuándo escalar

Todo esto es para **poco tráfico**. Señales para crecer:

- **DB con carga** → migra Postgres a **Managed Database** (backups + HA).
- **PDFs/colas saturan CPU** → separa un worker de la API en otro contenedor/Droplet.
- **Optimización de rutas real** → Droplet aparte para OSRM+VROOM
  (`docker/routing.compose.yml`), 4–8 GB para el extracto de Colombia, y fija
  `ROUTING_PROVIDER=vroom_osrm` + `ROUTING_VROOM_URL`.
- **Alta disponibilidad** → App Platform o varios Droplets tras un Load Balancer.
```
