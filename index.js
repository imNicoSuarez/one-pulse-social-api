// Importamos módulos esenciales
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const path = require('path');

// --- CONFIGURACIÓN CRÍTICA ---
// Asegúrate de definir estas variables de entorno en Render
const N8N_SAVE_TOKEN_WEBHOOK = process.env.N8N_SAVE_TOKEN_WEBHOOK || 'https://tu-n8n.com/webhook/save-token';
const N8N_GET_TOKENS_WEBHOOK = process.env.N8N_GET_TOKENS_WEBHOOK || 'https://tu-n8n.com/webhook/get-tokens';
const JWT_SECRET = process.env.JWT_SECRET || 'SUPER_SECRETO_DE_RENDER';
const PORT = process.env.PORT || 3000;

// Inicialización de Express
const app = express();

// --- MIDDLEWARES ---

// 1. CORS: Permite que el frontend acceda al backend
app.use(cors({
    origin: '*', // En producción, reemplaza con el dominio de tu frontend
    methods: ['GET', 'POST', 'PUT', 'DELETE']
}));

// 2. Body Parser: Para procesar JSON
app.use(bodyParser.json());

// 3. Autenticación de Usuario (Simulada para esta fase)
const authenticateUser = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ message: 'Authorization header missing' });
    }
    
    // En un sistema real, aquí se verificaría un JWT
    const token = authHeader.split(' ')[1];
    if (token !== 'MOCKED_JWT_12345') {
        return res.status(403).json({ message: 'Invalid or expired user token' });
    }
    // Asignamos el ID de usuario a la solicitud (debería venir del JWT real)
    req.userId = req.query.user_id || 'ImNicoSuarez_ID'; 
    next();
};

// 4. Multer para manejo de archivos (los guarda temporalmente en /uploads)
const upload = multer({ dest: 'uploads/' });


// ----------------------------------------------------------------------------------
// 1. ENDPOINTS: GESTIÓN DE TOKENS (TOKEN STORE GATEWAY)
// ----------------------------------------------------------------------------------

// POST /api/v1/token_store - Guardar Token
app.post('/api/v1/token_store', authenticateUser, async (req, res) => {
    // 1. Recibir los datos del token desde el Frontend
    const { userId, platform, access_token, refresh_token, expiresAt } = req.body;

    if (!userId || !platform || !access_token || !expiresAt) {
        return res.status(400).json({ status: 'error', message: 'Missing required token fields.' });
    }

    try {
        // 3. Persistir (n8n): Enviar solicitud POST al Webhook de n8n
        const n8nResponse = await axios.post(N8N_SAVE_TOKEN_WEBHOOK, req.body);
        
        // 4. Respuesta
        if (n8nResponse.status === 200 || n8nResponse.status === 201) {
            return res.status(200).json({ status: 'success', message: 'Token successfully persisted via n8n.' });
        } else {
            // Manejo de errores si n8n responde pero con un código no exitoso
             console.error("n8n responded with error:", n8nResponse.data);
            return res.status(500).json({ status: 'error', message: 'n8n persistence failed or returned unexpected status.' });
        }
    } catch (error) {
        console.error('Error saving token to n8n:', error.message);
        return res.status(500).json({ status: 'error', message: `Internal server error when communicating with n8n: ${error.message}` });
    }
});

// GET /api/v1/token_store - Obtener Tokens
app.get('/api/v1/token_store', authenticateUser, async (req, res) => {
    // 1. Recibir el userId (ya está en req.userId o se usa el query param)
    const userId = req.userId;

    try {
        // 2. Obtener (n8n): Enviar solicitud GET al Webhook de n8n
        const n8nResponse = await axios.get(`${N8N_GET_TOKENS_WEBHOOK}?userId=${userId}`);
        
        // 3. Formatear la respuesta (asumiendo que n8n devuelve { tokens: { platform: {data} } })
        // Si n8n devuelve un array, habría que transformarlo a un objeto.
        const tokens = n8nResponse.data.tokens || n8nResponse.data || {};

        // 4. Respuesta
        return res.status(200).json({ status: 'success', tokens: tokens });

    } catch (error) {
        console.error('Error fetching tokens from n8n:', error.message);
        // Si n8n falla o el usuario no tiene tokens, devolvemos un objeto vacío en 200
        return res.status(200).json({ status: 'success', tokens: {} });
    }
});

// ----------------------------------------------------------------------------------
// 2. ENDPOINT: PUBLICACIÓN CENTRALIZADA
// ----------------------------------------------------------------------------------

// POST /api/v1/publish - Publicar Contenido
app.post('/api/v1/publish', authenticateUser, upload.single('media_file'), async (req, res) => {
    const filePath = req.file.path; // Ruta del archivo temporal subido por multer
    
    try {
        // 2. Preparar datos
        const userId = req.body.userId; // Usado para obtener tokens
        const caption = req.body.caption;
        const platforms = JSON.parse(req.body.platforms); // Array de plataformas seleccionadas
        const results = [];
        
        // 3. Obtener Tokens
        const tokenResponse = await axios.get(`${N8N_GET_TOKENS_WEBHOOK}?userId=${userId}`);
        const userTokens = tokenResponse.data.tokens || tokenResponse.data || {};
        
        // 4. Bucle de Publicación
        for (const platformId of platforms) {
            const tokenData = userTokens[platformId];
            let result = { platform: platformId, status: 'error', message: 'Fallo general de publicación.', platform_url: null, error_code: null };

            // Verifica si el token existe
            if (!tokenData || !tokenData.access_token) {
                result.message = 'Token de acceso no encontrado en n8n.';
                results.push(result);
                continue;
            }

            // --- LÓGICA DE VERIFICACIÓN Y REFRESCO DE TOKEN EN RENDER ---
            let currentToken = tokenData.access_token;
            const expiresAt = new Date(tokenData.expiresAt).getTime();
            const now = Date.now();
            const isExpired = now >= expiresAt;

            if (isExpired && tokenData.refresh_token) {
                // b. Refresco: Lógica para llamar a la API social (Meta/Google) para obtener un nuevo token.
                console.log(`Intentando refrescar token para ${platformId}...`);
                
                const newToken = await refreshPlatformToken(platformId, tokenData.refresh_token);
                
                if (newToken) {
                    currentToken = newToken.access_token;
                    // Actualizar n8n con el nuevo token y expiración
                    await updateN8nToken(userId, platformId, newToken);
                } else {
                    result.message = 'Token expirado y falló el intento de refresco.';
                    results.push(result);
                    continue; // Saltar a la siguiente plataforma
                }
            } else if (isExpired && !tokenData.refresh_token) {
                result.message = 'Token expirado y no se encontró token de refresco. Reconexión necesaria.';
                results.push(result);
                continue;
            }

            // --- LÓGICA DE PUBLICACIÓN FINAL ---
            console.log(`Publicando en ${platformId} con token válido...`);
            
            // c. Publicación: Aquí iría la llamada a la API específica (simulada aquí)
            const publishResult = await publishToPlatform(platformId, currentToken, caption, filePath);
            results.push(publishResult);
        }

        // 5. Limpieza: Eliminar el archivo temporal
        fs.unlink(filePath, (err) => {
            if (err) console.error('Error deleting temp file:', err);
            console.log(`Temporal file deleted: ${filePath}`);
        });

        // 6. Respuesta
        return res.status(200).json({ status: 'success', message: 'Publication process finished.', results });

    } catch (error) {
        console.error('Error during publish process:', error.message);
        
        // 5. Limpieza (Asegurar la eliminación incluso en caso de error)
        if (filePath && fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
                if (err) console.error('Error deleting temp file on crash:', err);
            });
        }
        
        return res.status(500).json({ status: 'error', message: `Internal server error: ${error.message}` });
    }
});


// ----------------------------------------------------------------------------------
// 3. FUNCIONES DE UTILIDAD (Simuladas - Debes completar la lógica real)
// ----------------------------------------------------------------------------------

/**
 * Simula la llamada a la API de la plataforma social para refrescar el token.
 * @param {string} platformId - ID de la plataforma
 * @param {string} refreshToken - Token de refresco guardado en n8n
 * @returns {object | null} Nuevo objeto de token o null si falla.
 */
async function refreshPlatformToken(platformId, refreshToken) {
    // ESTA ES LA LÓGICA CLAVE A IMPLEMENTAR
    // Ejemplo: Llamada a Google/Meta usando refreshToken y CLIENT_SECRET
    
    // Aquí iría la llamada real (axios.post) a la API de OAuth de Google o Meta
    
    // SIMULACIÓN: Éxito en el 80% de los casos
    if (Math.random() > 0.2) {
        const newAccessToken = `REFRESHED_${platformId}_${Date.now().toString(36)}`;
        const newExpiresAt = new Date(Date.now() + 3600000).toISOString(); // +1 hora
        return {
            access_token: newAccessToken,
            refresh_token: refreshToken, // Reusa el refresh token si la API lo permite
            expiresAt: newExpiresAt,
        };
    }
    return null; // Falla el refresco
}

/**
 * Simula la publicación real en la plataforma social.
 * @param {string} platformId - ID de la plataforma
 * @param {string} token - Token de acceso válido
 * @param {string} caption - Descripción del contenido
 * @param {string} filePath - Ruta local del archivo multimedia
 * @returns {object} Objeto de resultado de publicación.
 */
async function publishToPlatform(platformId, token, caption, filePath) {
    // ESTA ES LA LÓGICA CLAVE A IMPLEMENTAR
    // Aquí irían las llamadas específicas a cada API (Meta Graph, YouTube Data, etc.)
    // usando el 'token' y el 'filePath'.
    
    // SIMULACIÓN
    const platformConfig = {
        'instagram': { name: 'Instagram', successUrl: 'https://instagram.com/p/mock-id-' },
        'youtube': { name: 'YouTube', successUrl: 'https://youtu.be/mock-id-' },
        'x': { name: 'X', successUrl: 'https://x.com/post/mock-id-' },
        'tiktok': { name: 'TikTok', successUrl: 'https://tiktok.com/@post/mock-id-' },
    };
    
    await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 1000)); // Simula latencia
    
    if (Math.random() < 0.15) { // 15% de error simulado
        return { platform: platformId, status: 'error', message: `API de ${platformConfig[platformId].name} rechazó la subida.`, platform_url: null, error_code: '403-MEDIA-REJECTED' };
    }

    // SIMULACIÓN de éxito
    const postId = Date.now().toString(36);
    return {
        platform: platformId,
        status: 'success',
        message: `Publicación finalizada en ${platformConfig[platformId].name}.`,
        platform_url: `${platformConfig[platformId].successUrl}${postId}`,
        error_code: null
    };
}

/**
 * Llama a n8n para actualizar el token después de un refresco exitoso.
 */
async function updateN8nToken(userId, platformId, newToken) {
    const dataToSave = {
        userId: userId,
        platform: platformId,
        access_token: newToken.access_token,
        refresh_token: newToken.refresh_token,
        expiresAt: newToken.expiresAt,
    };
    try {
        await axios.post(N8N_SAVE_TOKEN_WEBHOOK, dataToSave);
        console.log(`n8n token updated for ${platformId}`);
    } catch (error) {
        console.error(`ERROR: Failed to update n8n token for ${platformId}:`, error.message);
        // Si falla la actualización en n8n, el token se perderá en el próximo reinicio
    }
}


// ----------------------------------------------------------------------------------
// 4. INICIO DEL SERVIDOR
// ----------------------------------------------------------------------------------

app.listen(PORT, () => {
    console.log(`🚀 API Gateway running on port ${PORT}`);
    console.log(`N8N Save Webhook: ${N8N_SAVE_TOKEN_WEBHOOK}`);
});
