# Google SSO — Frappe CRM (`crm-yqh-dgj.m.frappe.cloud`)

**Estado: ✅ Operativo desde 2026-05-04.**

Guía operativa para habilitar **login con Google** en el CRM, conviviendo con
el método tradicional user/password. Los agentes pueden elegir cualquiera de
los dos en `/login`.

> Política original: "solo Google, sin password". **Cambió** durante el rollout
> (decisión 2026-05-04) → **se permiten ambos métodos**. Razones:
> 1. Si Google falla (provider down, secret rotado, etc.), nadie queda afuera.
> 2. Menor riesgo de lockout para el admin "break-glass".
> 3. Migración progresiva: los agentes que ya tienen passwords pueden seguir
>    usándolos hasta que adopten Google a su ritmo.
>
> Las secciones 5 y 5.2 ("desactivar password login" + "hide form CSS")
> quedan como **apéndice opcional** — se aplican si en el futuro se decide
> volver a forzar Google único.

---

## 1. Objetivo

- **Botón "Login con Google"** en `/login` — además del form user/password.
- **JIT provisioning**: el primer login crea automáticamente el `User` Frappe
  si el email coincide con un agente existente (o si los signups están
  permitidos a nivel site).
- **Identidad portable**. El email Google del agente sirve como clave canónica
  entre CRM, Chatwoot, Drive, etc.

## 2. Prerrequisitos

- Acceso de admin a un proyecto Google Cloud (idealmente bajo el Workspace
  `clinyco.cl`). Si no existe, crear `clinyco-crm` en
  https://console.cloud.google.com/.
- Acceso `System Manager` al site Frappe Cloud (`crm-yqh-dgj.m.frappe.cloud`).
- Decisión: ¿restringimos a dominio `@clinyco.cl` (Workspace) o aceptamos
  cualquier Gmail? **Recomendado**: solo Workspace (sec 6).

## 3. Paso 1 — Google Cloud Console (manual)

### 3.1 OAuth Consent Screen

1. https://console.cloud.google.com/apis/credentials/consent
2. **User Type**:
   - `Internal` si Clinyco usa Google Workspace `clinyco.cl` → solo usuarios del
     Workspace pueden loguear (no requiere verification de Google).
   - `External` si conviven Gmail personales → requiere verification si
     pasamos de 100 usuarios; para 10 agentes está OK en *Testing* mode.
3. App information:
   - Nombre: `Clinyco CRM`
   - User support email: `soporte@clinyco.cl`
   - Logo: opcional
4. Scopes: agregar `email`, `profile`, `openid` (los 3 mínimos).
5. Test users (solo si External + Testing): listar los emails de los agentes.

### 3.2 OAuth 2.0 Client ID

1. https://console.cloud.google.com/apis/credentials → **+ CREATE CREDENTIALS**
   → **OAuth client ID**.
2. Application type: **Web application**.
3. Name: `Frappe CRM Clinyco`.
4. **Authorized JavaScript origins**:
   ```
   https://crm-yqh-dgj.m.frappe.cloud
   https://crm.clinyco.cl
   ```
5. **Authorized redirect URIs** (los dos desde el día 1, así no hay que volver
   a editar cuando se hace el swap a `crm.clinyco.cl`):
   ```
   https://crm-yqh-dgj.m.frappe.cloud/api/method/frappe.integrations.oauth2_logins.login_via_google
   https://crm.clinyco.cl/api/method/frappe.integrations.oauth2_logins.login_via_google
   ```
6. **Create** → guardar `Client ID` y `Client Secret`.

> El secret se ve **una vez** en la UI; copiarlo a 1Password / Render env vars
> antes de cerrar la modal.

## 4. Paso 2 — Frappe Social Login Key

Dos caminos: UI manual o script idempotente.

### 4.1 UI manual

1. `https://crm-yqh-dgj.m.frappe.cloud/app/social-login-key`
2. **+ Add Social Login Key**.
3. Campos:
   - `Provider Name`: `Google`
   - `Social Login Provider`: `Google` (auto-rellena URLs)
   - `Client ID`: el del Paso 1
   - `Client Secret`: el del Paso 1
   - `Sign ups`: `Allow` (necesario para JIT provisioning)
   - `Enable Social Login`: ✅
4. **Save**.
5. Logout → en la página de login debe aparecer el botón **Login with Google**.

### 4.2 Script idempotente

Ver `migration/setup-google-sso.py`. Reusa el mismo patrón de los otros
scripts (env vars `FRAPPE_CLOUD_*`, sin deps externas). Ejemplo:

```bash
export FRAPPE_CLOUD_SITE_URL=https://crm-yqh-dgj.m.frappe.cloud
export FRAPPE_CLOUD_API_KEY=...
export FRAPPE_CLOUD_API_SECRET=...
export GOOGLE_OAUTH_CLIENT_ID=...
export GOOGLE_OAUTH_CLIENT_SECRET=...

python3 migration/setup-google-sso.py            # dry-run, muestra el plan
python3 migration/setup-google-sso.py --execute  # aplica
```

## 5. Paso 3 — Desactivar password login (⚠️ APÉNDICE OPCIONAL — no aplicar por defecto)

> **Esta sección NO se aplica con la política actual** (Google + user/pass conviven).
> Queda documentada por si en el futuro se decide volver a Google único.

Frappe Cloud Managed no permite editar `site_config.json` directamente. Usamos
los toggles en **System Settings** + un override CSS opcional.

### 5.1 System Settings (UI)

`/app/system-settings`:

| Campo | Valor objetivo | Razón |
|---|---|---|
| `Disable User Pass Login` | ✅ (si existe en v16) | bloquea login user/pass directo |
| `Allow Login using Mobile Number` | ☐ | no aplica al caso |
| `Allow Login using User Name` | ☐ | forzar login solo por email Google |
| `Login with email link` | ☐ | evita el "magic link" alternativo |
| `Force User to Reset Password` | `0` días | irrelevante si no hay password |
| `Allow Sign Up` | ☐ (a nivel website) | igual el JIT del SSO sí crea user |

> Si `Disable User Pass Login` no aparece en v16, ignoralo y aplicá la
> mitigación CSS de la sec 5.2.

### 5.2 Hide password fieldset (Website Theme custom CSS)

Si la pantalla `/login` sigue mostrando el form user/pass, agregar en
**Website Settings → Custom CSS**:

```css
/* Force Google-only login */
.login-content .for-email,
.login-content .field-icon,
.login-content #login_email,
.login-content #login_password,
.login-content .btn-login,
.login-content .forgot-password,
.login-content .signup-link {
  display: none !important;
}
.social-login-buttons { margin-top: 0 !important; }
```

(Selectors de v16; si cambian, inspeccionar `/login` y ajustar.)

## 6. Paso 4 — JIT provisioning + default role

### 6.1 Default Role Profile

Crear un Role Profile que represente al "Agente CRM" típico:

`/app/role-profile/new`:
- `Role Profile`: `CRM Agente Comercial`
- Roles: `Sales User`, `CRM User`, `Customer`, `Employee` (ajustar a needs)

Asignarlo como **default** vía `System Settings.default_role_profile_name`
(si v16 lo expone) o manualmente al primer User generado.

### 6.2 Domain restriction (Workspace `@clinyco.cl`)

Frappe no expone un campo "allowed domains" en Social Login Key, pero hay 3
caminos:

1. **OAuth Consent Screen Internal** (recomendado): Google ya filtra por
   Workspace. Cualquier Gmail externo recibe error de Google antes de llegar
   a Frappe.
2. **Hook server-side**: Server Script tipo `before_save` en User que rechaza
   emails fuera del dominio:
   ```python
   if not doc.email.endswith("@clinyco.cl"):
       frappe.throw("Solo se permiten cuentas @clinyco.cl")
   ```
3. **Manual approval**: dejar `Sign ups: Manual` en Social Login Key — el
   primer login crea el User pero como `disabled=1` hasta que un admin lo
   active. Más fricción, más control.

## 7. Paso 5 — Validación end-to-end

1. **Logout** del admin actual.
2. Ir a `https://crm-yqh-dgj.m.frappe.cloud/login`.
3. Click **Login with Google**.
4. Loguear con un Gmail de prueba (idealmente uno **no creado todavía** como
   User en Frappe).
5. Verificar:
   - [ ] Se redirige al desk Frappe sin pedir password.
   - [ ] `/app/user` muestra el nuevo User con email Google.
   - [ ] El User tiene los roles del Role Profile default.
   - [ ] El form user/pass está oculto en `/login`.
6. Logout y volver a entrar — debe ser un solo click.

## 8. Otras apps en el ecosistema Google

El requisito "necesitan para otras aplicaciones estar en gmail account perfil"
se cumple naturalmente: como cada app (Chatwoot, sell-medinet-backend,
clinyco_AI) usa el mismo email Google del agente como identificador, el SSO
queda alineado:

- **Chatwoot Cloud**: tiene su propio Google SSO en Settings → Account
  Settings → SSO. Usar el mismo OAuth Client ID y agregar este redirect:
  `https://app.chatwoot.com/auth/google_oauth2/callback`.
- **Render dashboards / GitHub / Drive**: ya autentican con Google nativamente.
- **sell-medinet-backend**: si en el futuro expone una UI propia, reusar el
  mismo OAuth Client ID con un redirect adicional.

Una sola identidad Google → todas las apps. No hay duplicación de credenciales.

## 9. Rollback

Si algo se rompe y necesitamos volver al login user/pass de emergencia:

1. **Disable** la Social Login Key (UI o `enable_social_login=0` vía API).
2. Restaurar password de un admin existente: System Manager con email Google
   ya seteado puede usar `/api/method/frappe.core.doctype.user.user.reset_password`
   con un email válido.
3. Quitar el CSS de Website Settings.
4. Reactivar `Allow Sign Up` si fue desactivado.

> Ojo: si **todos** los admins se crearon vía Google y no tienen password
> seteado, y la Social Login Key está mal configurada, podés quedar bloqueado.
> **Mitigación**: mantener al menos un admin "break-glass" con password local
> y MFA, no creado por Google. No publicar sus credenciales — guardarlas en
> 1Password.

## 10. Credenciales / env vars resultantes

| Var | Dónde se guarda | Para qué |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Render env (sell-medinet-backend, clinyco_AI), Frappe Social Login Key | OAuth handshake |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Render env, Frappe Social Login Key, 1Password | OAuth handshake (no commitear) |
| `FRAPPE_CLOUD_API_KEY` / `_SECRET` | Render env, 1Password | API Frappe (ya existe) |

## 11. Troubleshooting — lecciones del rollout (2026-05-04)

Sesión real de ~4 horas para que el flow funcionara end-to-end. Síntomas y
causas reales encontradas, en orden de frecuencia:

### 11.1 `Error 401: invalid_client — The OAuth client was not found`

Aparece en la pantalla de Google (no llega a Frappe).

- **Causa real**: el **Client ID** pegado en Frappe no coincide con un cliente
  activo en Google Cloud Console. Casi siempre por typo o por estar
  trabajando en **el proyecto Google equivocado**.
- **Fix**: copiar el Client ID exacto desde el modal de Google (con el
  ícono 📋, no a mano). Verificar que el OAuth Client está en `clinyco-crm`
  y no en otro project.

### 11.2 `Decoder failed to handle access_token ... invalid_client ... The provided client secret is invalid`

Aparece **del lado Frappe** (pantalla "Error del Servidor 500"). Para verlo, ir a
`/app/error-log` o click "Mostrar error" en la pantalla 500.

- **Causa típica**: el **Client Secret** quedó pegado mal en Frappe. Subcasos
  reales encontrados:
  1. **Se pegó la URL de redirect** (`https://crm-yqh-dgj.m.frappe.cloud/api/...`)
     en el campo Secret en lugar del valor real `GOCSPX-...`. El traceback
     lo expone literal en `client_secret='https://...'`.
  2. **El secret se pegó cortado** (Cmd+C no copió todo). Los secrets de
     Google son **35 chars**, formato `GOCSPX-` + 28 chars. Verificar con el
     ícono 👁 y contar.
  3. **El secret quedó "huérfano"** en Google: aparece en el JSON descargado
     y en la UI como "Habilitada", pero Google lo rechaza igual. Solución
     definitiva: **borrar el OAuth Client entero y crear uno nuevo desde cero**.
     Recrear el client + secret destrabó el rollout final.
- **Cómo diagnosticar**: el `repr` del traceback en `/app/error-log` muestra
  el valor exacto que Frappe envía. Comparar carácter por carácter con el
  modal del OAuth Client en Google Cloud.

### 11.3 `login_via_google() missing 2 required positional arguments: 'code' and 'state'`

- **Causa**: el browser cargó la URL del callback **sin los query params**.
  Pasa cuando el usuario reloadea la página de error 500 — el reload re-pega
  la URL pero sin el `?code=...&state=...` que Google había agregado.
- **Fix**: ignorar este entry, no es la causa raíz. El error real está en
  otra entrada del log con `form_dict` conteniendo `code` y `state`.

### 11.4 Login con Google funciona pero el user no entra al CRM

- **Causa**: el User en Frappe existe pero su **Tipo de Usuario** es
  `Website User` (default si se migró desde otra fuente). Los Website Users
  no tienen acceso al desk Frappe ni típicamente al FCRM.
- **Fix**: en `/app/user/{email}` cambiar **Tipo de Usuario** a `System User`.
  Verificable rápido en `/app/user?enabled=1` columna "Tipo de usuario".

### 11.5 Email mismatch entre Google y Frappe

- **Causa**: la cuenta Google del agente es `villagran@clinyco.cl` pero el
  User Frappe tiene email `dr.villagran@clinyco.cl` (con prefijo).
- **Fix**: el email del User Frappe debe ser **idéntico** al de la cuenta
  Google. Frappe permite "merge" entre dos users si ambos existen
  (cambiar email tira merge automático).

### 11.6 Browser cache del error 500

- Después de fallar varias veces, el browser cachea la página de error.
- **Fix**: cerrar TODAS las ventanas incógnito y abrir una nueva.

---

## 12. Referencias

- Frappe Social Login Key (v16):
  https://docs.frappe.io/framework/user/en/guides/integration/social-logins
- Google OAuth 2.0 Web Server flow:
  https://developers.google.com/identity/protocols/oauth2/web-server
- `docs/migration-chatwoot-frappe.md` § 11 (credenciales)
- `migration/MIGRATION_STATE.md` § 13 (estado operativo)
- `migration/setup-google-sso.py` (automatización del paso 4.2)
