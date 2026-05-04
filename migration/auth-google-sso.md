# Google SSO único — Frappe CRM (`crm-yqh-dgj.m.frappe.cloud`)

Guía operativa para que los agentes ingresen al CRM **solamente con su cuenta
Google** (sin password local) y queden auto-provisionados en el primer login.

---

## 1. Objetivo y motivación

- **Login único = Google**. Cada agente ya tiene cuenta Google (Gmail/Workspace)
  para email, Drive, etc. Reusamos esa identidad como SSO del CRM.
- **No password local**. Eliminamos la creación de passwords paralelos: menos
  superficie de ataque, sin reseteos manuales.
- **JIT provisioning**. El primer login crea automáticamente el `User` Frappe
  con un Role Profile por defecto. Sin alta manual previa.
- **Identidad portable**. El email Google del agente es la clave canónica entre
  CRM, Chatwoot, Drive, etc. No hay que mantener listas de usuarios paralelas.

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

## 5. Paso 3 — Desactivar password login

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

## 11. Referencias

- Frappe Social Login Key (v16):
  https://docs.frappe.io/framework/user/en/guides/integration/social-logins
- Google OAuth 2.0 Web Server flow:
  https://developers.google.com/identity/protocols/oauth2/web-server
- `docs/migration-chatwoot-frappe.md` § 11 (credenciales pendientes)
- `migration/MIGRATION_STATE.md` § 13 (pendientes operativos)
- `migration/setup-google-sso.py` (automatización del paso 4.2)
