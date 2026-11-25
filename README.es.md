<!-- Keep README.md, README.zh-CN.md, and README.es.md aligned when changing project facts. -->
<h1 align="center">FlarePort</h1>

<p align="center">
  <strong>Grandes proyectos de código abierto, más fáciles de desplegar en Cloudflare.</strong><br />
  Open-source apps, ported to Cloudflare.
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <strong>Español</strong>
</p>

<p align="center">
  <a href="https://github.com/LJAYi/flareport/actions/workflows/ci.yml"><img src="https://github.com/LJAYi/flareport/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="Herramientas de FlarePort: licencia MIT" /></a>
  <a href="#estado-del-proyecto"><img src="https://img.shields.io/badge/Status-Public%20Preview-f38020" alt="Versión preliminar pública" /></a>
</p>

<p align="center">
  <a href="#catálogo-de-plantillas">Elegir una plantilla</a> ·
  <a href="#inicio-rápido">Inicio rápido</a> ·
  <a href="#mantener-tu-despliegue-actualizado">Actualizaciones</a> ·
  <a href="#cómo-contribuir">Contribuir</a> ·
  <a href="#agradecimientos">Agradecimientos</a>
</p>

---

FlarePort es una **colección de plantillas de despliegue de código abierto, mantenida por la comunidad y gestionada sin fines comerciales**. Reunimos adaptadores para Cloudflare, instrucciones de configuración y vías de actualización para proyectos de código abierto existentes, para que puedas empezar con un botón de despliegue y ejecutar tus servicios favoritos en tu propia cuenta.

**Los autores originales crean las aplicaciones. FlarePort te ayuda a desplegarlas. Tú conservas el control de tus servicios y datos.**

- **Empieza con una plantilla**: crea tu repositorio de despliegue mediante el asistente, sin hacer un fork de FlarePort ni del proyecto original.
- **Conserva la propiedad**: los repositorios están en tu cuenta de GitHub; los Workers, bases de datos, secretos y datos de las aplicaciones, en tu cuenta de Cloudflare.
- **Verifica el origen**: las compilaciones utilizan un commit fijado del proyecto original y verifican el SHA-256 del archivo de código fuente.
- **Decide cómo actualizar**: la revisión manual sigue disponible; la fusión automática y las actualizaciones por fases requieren configuración adicional y tu consentimiento explícito.

> [!NOTE]
> FlarePort está en fase de versión preliminar pública. Las plantillas de despliegue y el Bot de actualizaciones tienen distintos niveles de disponibilidad; consulta su estado a continuación. No es un servicio de alojamiento ni una herramienta universal que convierta cualquier repositorio de GitHub en un Worker.

## Catálogo de plantillas

Actualmente hay **2 plantillas**. Ambas son adaptaciones de la comunidad, sin respaldo oficial de los proyectos originales ni de Cloudflare.

| Plantilla | Finalidad | Estado | Desplegar |
| --- | --- | --- | --- |
| **[NodeWarden](templates/nodewarden/README.md)** | Gestor de contraseñas autoalojado compatible con Bitwarden | Disponible para probar · Despliegue verificado por el mantenedor | [![Desplegar NodeWarden en Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LJAYi/flareport/tree/main/templates/nodewarden) |
| **[OpenConnector](templates/open-connector/README.md)** | Pasarela de autenticación de código abierto que conecta agentes de IA con servicios de terceros | Experimental · Pendiente de corregir la sincronización de nuevas versiones | [![Desplegar OpenConnector en Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LJAYi/flareport/tree/main/templates/open-connector) |

<details>
<summary>Antes de desplegar: recursos, secretos obligatorios y limitaciones conocidas</summary>

| Plantilla | Recursos de Cloudflare | Secrets obligatorios | Proyecto original y versión |
| --- | --- | --- | --- |
| NodeWarden | Workers, D1, R2, Durable Objects | `JWT_SECRET`: valor aleatorio criptográficamente seguro de al menos 32 caracteres | [shuaiplus/nodewarden](https://github.com/shuaiplus/nodewarden) · [Versión fijada](templates/nodewarden/UPSTREAM.md) |
| OpenConnector | Workers, D1, R2 | `OOMOL_CONNECT_ADMIN_TOKEN`, `OOMOL_CONNECT_ENCRYPTION_KEY`: valores aleatorios largos generados por separado | [oomol-lab/open-connector](https://github.com/oomol-lab/open-connector) · [Versión fijada](templates/open-connector/UPSTREAM.md) |

La [validación de sincronización de una nueva versión](https://github.com/LJAYi/flareport/actions/runs/45394775408) de OpenConnector falló porque la comprobación de seguridad rechazó enlaces simbólicos en el archivo de código fuente. Esa versión candidata no se publicó. El botón anterior utiliza la versión actualmente fijada en la plantilla; **no significa que la última versión del proyecto original sea compatible**. Recomendamos empezar con NodeWarden si eres un usuario nuevo.

Estado comprobado el 2026-11-25. La verificación del despliegue por parte del mantenedor no equivale a una auditoría de seguridad completa ni garantiza que todas las cuentas, configuraciones o versiones futuras funcionen sin problemas.

</details>

## Inicio rápido

**Prepara una cuenta de GitHub y otra de Cloudflare y, a continuación:**

1. **Elige una plantilla.** Lee su guía, comprueba que los servicios necesarios estén habilitados y pulsa **Deploy to Cloudflare**.
2. **Crea tu repositorio de despliegue.** Sigue el asistente de Cloudflare para conectar GitHub y dar un nombre a tu repositorio, por ejemplo `my-nodewarden`. El asistente copia la plantilla seleccionada; no necesitas hacer dos forks.
3. **Configura y despliega.** Introduce los secretos aleatorios en Cloudflare Secrets y revisa la configuración de recursos y compilación. La compilación descarga y verifica el código fuente fijado del proyecto original.
4. **Abre tu servicio.** Cuando termine la compilación, visita la dirección proporcionada por Cloudflare y sigue la documentación del proyecto original para completar la configuración. Añade un dominio propio si lo necesitas.

**Desplegar una aplicación no requiere instalar FlarePort Bot ni desplegar el Bot en tu cuenta.** La integración de Cloudflare con GitHub se encarga de compilar y desplegar; FlarePort Bot es una vía independiente y opcional para gestionar actualizaciones.

> [!IMPORTANT]
> Un botón de despliegue no significa que no haya que configurar nada ni que el alojamiento sea gratuito para siempre. Comprueba los requisitos de activación, los [límites de uso](https://developers.cloudflare.com/workers/platform/limits/) y las [tarifas](https://developers.cloudflare.com/workers/platform/pricing/) de Workers, D1, R2 y otros servicios necesarios. Nunca incluyas secretos reales en un commit ni los publiques en un issue. Verifica las copias de seguridad y la recuperación antes de almacenar datos importantes, especialmente en una bóveda de contraseñas.

### ¿Quieres desplegar varios servicios?

Despliega cada servicio por separado, con su propio repositorio de despliegue y Worker de aplicación de forma predeterminada. Normalmente puedes reutilizar las conexiones de las cuentas; los secretos, dominios y datos se gestionan por separado. Añadir servicios a la misma cuenta no crea una cuota gratuita independiente a nivel de cuenta para cada servicio.

Si despliegas varias instancias de una misma plantilla, revisa y diferencia los nombres y enlaces de recursos (bindings) de Workers, D1 y R2 para no reutilizar recursos existentes por error. Una vez configurada la gestión de actualizaciones, un único FlarePort Bot puede gestionar varios despliegues registrados.

## Mantener tu despliegue actualizado

Las actualizaciones tienen dos niveles: **nueva versión del proyecto original → FlarePort valida y revisa la actualización de la plantilla → tu repositorio recibe un PR de actualización → al fusionarlo, Cloudflare compila y despliega.** Los dos últimos pasos requieren configurar una vía de actualización; no se activan simplemente al pulsar el botón de despliegue.

| Política de actualización | Tu intervención | Uso recomendado |
| --- | --- | --- |
| `manual` | Revisas el PR de actualización y lo fusionas tú mismo | Opción predeterminada recomendada, especialmente para contraseñas y datos importantes |
| `auto` | Das tu consentimiento; solo se fusiona si se cumplen las validaciones y la protección de ramas | Despliegues con medidas de verificación y recuperación |
| `staged-auto` | Cumples los requisitos de actualización automática y esperas los resultados de la fase anterior | Despliegues que participan en publicaciones por fases |

Hay dos vías de actualización. **Elige una sola vía de actualización programada por repositorio**:

- **GitHub Actions en tu repositorio**: las plantillas incluyen flujos de actualización semanales y de ejecución manual. El botón de despliegue puede omitir `.github/workflows`; después de desplegar, comprueba, restaura y revisa los flujos y los permisos del repositorio.
- **FlarePort Bot**: una GitHub App compartida, operada por el mantenedor, que gestiona PR de actualización, comprobaciones de fusión y publicaciones por fases para los repositorios registrados. Instalar la App y registrar una plantilla y su política de actualización son pasos distintos.

> [!WARNING]
> **La incorporación totalmente autónoma al Bot todavía no está disponible para terceros.** A fecha de 2026-11-25, la App de producción es privada, el registro de repositorios requiere ayuda del mantenedor y no están habilitados ni la publicación automática central ni el envío automático de PR. Que el núcleo del Bot esté implementado no significa que todos los despliegues estén suscritos automáticamente a las actualizaciones.

La fusión automática siempre requiere consentimiento explícito del usuario, comprobaciones obligatorias y protección de ramas; una plantilla central no puede activarla por ti. Las actualizaciones de versión enviadas por el Bot no modifican los Secrets de ejecución, la configuración de recursos de Wrangler ni los flujos de trabajo. Los nuevos bindings, cambios en el código del adaptador y migraciones de bases de datos siguen necesitando revisión y trabajo de migración por separado. **Que la compilación y el despliegue terminen correctamente no demuestra que la aplicación funcione bien ni permite revertir automáticamente cambios en la base de datos.**

El mantenedor puede elegir [Cloudflare Cron, GitHub Actions Cron o la ejecución manual](apps/github-bot/README.md#central-scheduler) para las comprobaciones periódicas del Bot. En modo nativo, un único temporizador del Bot atiende varias plantillas y despliegues; las tareas de copia de seguridad y limpieza propias de cada aplicación siguen siendo independientes.

## Estado del proyecto

- [x] Directorios de plantillas de NodeWarden y OpenConnector con botones de despliegue.
- [x] Commits originales fijados, verificación de hashes de archivos, pruebas de plantillas y flujos de validación de compilaciones.
- [x] Detección de versiones originales y PR revisados manualmente para las plantillas públicas.
- [x] Funciones centrales del Bot para PR de actualización, requisitos de validación, observaciones de despliegue y fuentes seleccionables de comprobaciones periódicas.
- [ ] Corregir la adaptación del archivo de código fuente de la nueva versión de OpenConnector.
- [ ] Abrir a terceros la instalación del Bot, el registro de repositorios y la configuración de políticas de actualización sin asistencia del mantenedor.
- [ ] Verificar el recorrido completo de un usuario nuevo, desde el primer despliegue hasta la primera actualización.

Esta lista describe funciones actuales y trabajo previsto, no fechas de entrega. Los servicios existentes no necesitan que todos los puntos estén completados para seguir funcionando.

## Cómo contribuir

Puedes recomendar proyectos, aportar adaptadores, mejorar la documentación o probar el despliegue con una cuenta nueva. Lee la [guía de contribución](CONTRIBUTING.md) antes de enviar tus cambios. Comunica las vulnerabilidades de forma privada siguiendo la [política de seguridad](SECURITY.md); no publiques detalles sensibles.

- **Propón una plantilla**: abre un [issue](https://github.com/LJAYi/flareport/issues) con el enlace al proyecto original, su licencia, el caso de uso y los requisitos de ejecución y recursos que conozcas.
- **Informa de problemas del adaptador**: indica la plantilla, la versión fijada, los pasos para reproducir el problema y los registros sin datos sensibles. Empieza en FlarePort; si el problema pertenece a la aplicación original, podemos ayudar a trasladarlo sin cargar a sus mantenedores con problemas específicos de la adaptación.
- **Aporta un adaptador**: empieza por el [ciclo de vida de los adaptadores](docs/adapter-lifecycle.md), conserva la atribución y licencia originales, fija un commit completo y el hash del archivo, declara los datos de configuración e incluye pruebas de la plantilla.
- **Ayuda a descubrir buenos proyectos**: si FlarePort te resulta útil, puedes darle una estrella, y también ofrecer estrellas, comentarios y apoyo a los autores originales que crean las aplicaciones.

<details>
<summary>Para desarrolladores: comprobaciones locales, estructura del repositorio y documentación técnica</summary>

Se necesita **Node.js 24+**. Ejecuta estos comandos en la raíz de este repositorio; no son requisitos previos para los usuarios que solo quieren desplegar una plantilla.

```bash
npm ci
npm run check
npm run catalog
```

| Directorio | Contenido |
| --- | --- |
| `adapters/` | Manifiestos de proyectos y referencias inmutables al código original |
| `packages/adapter-core/` | Especificaciones de adaptadores, validación y generación |
| `templates/` | Directorios de plantillas de despliegue independientes |
| `apps/github-bot/` | Worker del Bot opcional, almacenamiento de estado y coordinación de publicaciones |
| `src/` | Catálogo, CLI e integración a nivel de repositorio |

Documentación técnica: [Arquitectura y límites](docs/architecture.md) · [Ciclo de vida de los adaptadores](docs/adapter-lifecycle.md) · [Configuración y API del Bot](apps/github-bot/README.md) · [Modelo de amenazas](docs/threat-model.md).

Nombres: **FlarePort** es el nombre visible del proyecto; los repositorios, Workers y comandos usan `flareport`. La App de producción es **FlarePort Bot** (`flareport-bot`) y la de pruebas es **FlarePort Bot Canary** (`flareport-bot-canary`). Los nombres por sí solos no aíslan permisos, credenciales ni entornos de ejecución.

</details>

## Agradecimientos

**FlarePort se apoya en el trabajo que los autores originales crean y mantienen.** Gracias por compartir su código, conocimientos y tiempo con la comunidad de código abierto.

| Proyecto y colaboradores | Lo que hacen posible | Información sobre la licencia original |
| --- | --- | --- |
| [NodeWarden](https://github.com/shuaiplus/nodewarden) · [shuaiplus](https://github.com/shuaiplus) y todos sus colaboradores | Un servicio de gestión de contraseñas compatible con Bitwarden que funciona en Cloudflare Workers | [Atribución y código fuente: LGPL-3.0](templates/nodewarden/UPSTREAM.md) |
| [OpenConnector](https://github.com/oomol-lab/open-connector) · [OOMOL Lab](https://github.com/oomol-lab) y todos sus colaboradores | Autenticación de código abierto y conexiones con servicios de terceros para agentes de IA | [Atribución y código fuente: Apache-2.0](templates/open-connector/UPSTREAM.md) |
| [Cloudflare](https://developers.cloudflare.com/) y [GitHub](https://github.com/) | Workers, herramientas de despliegue, alojamiento de código, Actions y la plataforma de Apps | Cada plataforma y herramienta tiene sus propias condiciones |

Gracias también a quienes informan de problemas, revisan PR, prueban plantillas o mejoran la documentación. Juntos queremos ayudar a que los buenos proyectos lleguen a más usuarios, facilitar el autoalojamiento y compartir la experiencia de adaptación con el próximo colaborador.

## Licencia

Las herramientas propias de FlarePort se distribuyen bajo la [licencia MIT](LICENSE). **Esto no sustituye las licencias de las aplicaciones originales.** Al usar o distribuir una aplicación, debes cumplir su licencia y sus obligaciones de atribución, NOTICE y disponibilidad del código fuente.

FlarePort es un proyecto comunitario independiente. Los nombres y marcas pertenecen a sus respectivos titulares; mencionar un proyecto o una plataforma no implica una colaboración ni un respaldo oficial.
