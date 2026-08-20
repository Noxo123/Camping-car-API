import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { readMemories } from './storage/memories.js';
import { sourceList } from './config/sources.js';
import { collectAll } from './collectors/index.js';
import { normalizeResults } from './normalizers/merge.js';

const app = express();
const port = Number(process.env.PORT || 3050);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({origin: process.env.CORS_ORIGIN || '*'}));
app.use(express.json({limit:'256kb'}));
app.use(rateLimit({windowMs:60_000,limit:120,standardHeaders:'draft-8',legacyHeaders:false}));

function auth(req,res,next) {
  const key = process.env.API_KEY;
  if (!key) return next();
  const provided = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i,'');
  if (provided !== key) return res.status(401).json({error:'Clé API invalide'});
  next();
}

app.get('/api/v1/health',(req,res)=>res.json({ok:true,service:'Camping-car-API',time:new Date().toISOString()}));
app.get('/api/v1/sources',(req,res)=>res.json({sources:sourceList()}));
app.get('/api/v1/parks',auth,async(req,res)=>{const d=await readMemories();res.json({total:d.parks.length,parks:d.parks});});
app.get('/api/v1/parks/:id',auth,async(req,res)=>{const d=await readMemories();const p=d.parks.find(x=>x.id===req.params.id);if(!p)return res.status(404).json({error:'Aire introuvable'});res.json(p);});
app.get('/api/v1/search',auth,async(req,res)=>{const q=String(req.query.q||'').toLowerCase().trim();if(!q)return res.status(400).json({error:'q est requis'});const d=await readMemories();const parks=d.parks.filter(p=>JSON.stringify(p).toLowerCase().includes(q));res.json({total:parks.length,parks});});
app.get('/api/v1/nearby',auth,async(req,res)=>{const lat=Number(req.query.lat),lon=Number(req.query.lon),radius=Number(req.query.radius||25);if(!Number.isFinite(lat)||!Number.isFinite(lon))return res.status(400).json({error:'lat et lon sont requis'});const d=await readMemories();const km=(a,b,c,e)=>{const R=6371,x=(c-a)*Math.PI/180,y=(e-b)*Math.PI/180;const h=Math.sin(x/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(y/2)**2;return 2*R*Math.asin(Math.sqrt(h));};const parks=d.parks.map(p=>({...p,distanceKm:km(lat,lon,p.location.latitude,p.location.longitude)})).filter(p=>Number.isFinite(p.distanceKm)&&p.distanceKm<=radius).sort((a,b)=>a.distanceKm-b.distanceKm);res.json({total:parks.length,radiusKm:radius,parks});});
app.get('/api/v1/statistics',auth,async(req,res)=>{const d=await readMemories();const bySource={};for(const p of d.parks){const s=p.source?.platform||'unknown';bySource[s]=(bySource[s]||0)+1;}res.json({total:d.parks.length,bySource,generatedAt:d.metadata.generatedAt});});
app.post('/api/v1/admin/collect',auth,async(req,res)=>{try{const results=await collectAll();res.json({ok:true,results:results.map(r=>({source:r.source,records:r.records?.length||0,error:r.error||null}))});}catch(e){res.status(500).json({error:'Collecte échouée'});}});
app.use((err,req,res,next)=>res.status(500).json({error:'Erreur interne'}));
app.listen(port,process.env.HOST||'0.0.0.0',()=>console.log(`Camping-car-API listening on :${port}`));
