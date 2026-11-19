interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
  ARCHIVE_RETENTION_DAYS?: string;
  MAX_BOARD_CHECKS_PER_RUN?: string;
}
interface Candidate {
  title:string; company:string; location:string; country:string; remote:string;
  employment:string; salary:string; summary:string; description:string;
  tags:string[]; url:string; apply:string; published:string|null;
  eligibility:"eligible"|"not_eligible"|"unconfirmed"; eligibilityNote:string;
}
interface Board {
  id:number; provider:"greenhouse"|"lever"|"ashby"|"smartrecruiters";
  board_key:string; employer_name:string; official_domain:string|null;
  careers_url:string|null; country:string|null;
}
const H = {
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type,Authorization",
  "Cache-Control":"no-store"
};
const response = (data:unknown,status=200) => new Response(JSON.stringify(data),{status,headers:{...H,"Content-Type":"application/json; charset=utf-8"}});
const str = (v:any,max=30000):string => {
  if(v===null||v===undefined)return "";
  return String(v).replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim().slice(0,max);
};
const arr = (v:any):string[] => Array.isArray(v)?v.map(x=>str(typeof x==="object"&&x?(x.name??x.label??x):x,100)).filter(Boolean):typeof v==="string"?v.split(/[,;|]/).map(x=>str(x,100)).filter(Boolean):[];
function date(v:any):string|null { if(!v)return null; const d=new Date(typeof v==="number"?(v<1e10?v*1000:v):v);return Number.isNaN(d.getTime())?null:d.toISOString(); }
function normalize(v:any):Candidate|null {
  const title=str(v.title,300), company=str(v.company,200), url=str(v.url,2000);
  if(!title||!company||!/^https?:\/\//i.test(url))return null;
  const location=str(v.location,500), work=`${str(v.work)} ${location}`.toLowerCase();
  const remote=/hybrid/.test(work)?"hybrid":/on[- ]?site|onsite|in office/.test(work)?"onsite":/remote|worldwide|anywhere|distributed|telecommut/.test(work)?"remote":"unspecified";
  const region=`${location} ${str(v.country,100)}`.toLowerCase();
  let eligibility:Candidate["eligibility"]="unconfirmed", eligibilityNote="The source does not clearly state whether applicants in Nigeria are eligible. Check the employer's original listing.";
  if(/nigeria|anywhere|worldwide|global|all countries|africa|emea/.test(region)){eligibility="eligible";eligibilityNote="The listing indicates Nigeria, Africa, EMEA or worldwide eligibility; confirm restrictions on the employer page.";}
  else if(/united states only|us only|u\.s\. only|uk only|united kingdom only|canada only|europe only|eu only/.test(region)){eligibility="not_eligible";eligibilityNote="The source indicates a restricted hiring region that does not include Nigeria.";}
  const description=str(v.description,30000), summary=str(v.summary,900)||description.slice(0,500);
  return {title,company,location,country:str(v.country,100),remote,employment:str(v.employment,100),salary:str(v.salary,180),summary,description,tags:arr(v.tags),url,apply:str(v.apply,2000)||url,published:date(v.published),eligibility,eligibilityNote};
}
function fingerprint(j:Candidate){const n=(s:string)=>s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g," ").trim();return [n(j.company),n(j.title),n(j.location)].join("|");}
async function hash(s:string){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("").slice(0,40);}
async function getJson(url:string){const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"RoleAtlas/0.1 (+https://github.com/AgentCalmz/opportunity)"},signal:AbortSignal.timeout(18000)});if(!r.ok)throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);const raw=await r.text();if(raw.length>8_000_000)throw new Error("Response exceeded 8 MB limit");return {data:JSON.parse(raw),raw};}
function list(data:any,keys:string[]):any[]{if(Array.isArray(data))return data;for(const k of keys)if(Array.isArray(data?.[k]))return data[k];return [];}
function mapFeed(key:string,v:any):Candidate|null{
  if(key==="jobicy")return normalize({title:v.jobTitle,company:v.companyName,location:v.jobGeo??v.jobLocation,country:v.jobCountry,work:v.jobType??v.jobGeo,employment:v.jobType,summary:v.jobExcerpt,description:v.jobDescription,tags:v.jobIndustry,url:v.url,apply:v.url,published:v.pubDate,salary:v.annualSalaryMin?`${v.annualSalaryCurrency||""} ${v.annualSalaryMin}-${v.annualSalaryMax||""}`:""});
  if(key==="remoteok")return normalize({title:v.position,company:v.company,location:v.location,work:v.location,employment:v.type,summary:v.description,description:v.description,tags:v.tags,url:v.url?.startsWith("http")?v.url:`https://remoteok.com${v.url||""}`,apply:v.apply_url||v.url,published:v.date,salary:v.salary});
  if(key==="remotive")return normalize({title:v.title,company:v.company_name,location:v.candidate_required_location,country:v.candidate_required_location,work:"Remote",employment:v.job_type,summary:v.description,description:v.description,tags:v.tags,url:v.url,apply:v.url,published:v.publication_date,salary:v.salary});
  if(key==="arbeitnow")return normalize({title:v.title,company:v.company_name,location:v.location,work:v.remote?"Remote":v.location,employment:v.job_types,summary:v.description,description:v.description,tags:v.tags,url:v.url,apply:v.url,published:v.created_at});
  if(key==="remotejobsorg"){
    const allowed=v.location_normalization?.allowed_countries??v.applicant_location_requirements?.allowed_countries??[];
    const countryText=Array.isArray(allowed)?allowed.map((x:string)=>x==="NG"?"Nigeria":x).join(", "):"";
    return normalize({title:v.title,company:v.company?.name,location:v.location,country:countryText,work:v.location_normalization?.work_arrangement??v.location,employment:v.type??v.employment_types,summary:v.description,description:v.description,tags:[v.category?.name],url:v.url,apply:v.apply_url,published:v.posted_at,salary:v.salary_text});
  }
  // Himalayas is a remote-only feed. Its API terms require the supplied applicationLink
  // for Apply actions and visible attribution to Himalayas on every displayed listing.
  return normalize({title:v.title,company:v.companyName??v.company_name,location:v.location??v.locationRestrictions??"Remote",country:v.countries??v.locationRestrictions,work:"Remote",employment:v.employmentType??v.employment_type,summary:v.excerpt??v.description,description:v.description??v.excerpt,tags:v.categories??v.skills,url:v.applicationLink??v.url??v.jobUrl,apply:v.applicationLink??v.url??v.jobUrl,published:v.pubDate??v.publishedAt??v.createdAt,salary:v.salary});
}
async function save(env:Env,jobs:Candidate[],sourceKey:string,sourceName:string,sourceUrl:string){
  const now=new Date().toISOString(), statements:D1PreparedStatement[]=[];
  for(const j of jobs){
    const key=fingerprint(j),id=await hash(key);
    statements.push(env.DB.prepare(`INSERT INTO jobs(id,dedupe_key,title,company,location,country,remote_status,employment_type,salary,summary,description,tags,job_url,apply_url,eligibility_status,eligibility_note,published_at,first_seen_at,last_seen_at,last_verified_open_at,status,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open',?)
    ON CONFLICT(id) DO UPDATE SET location=COALESCE(NULLIF(excluded.location,''),jobs.location),country=COALESCE(NULLIF(excluded.country,''),jobs.country),remote_status=CASE WHEN excluded.remote_status='unspecified' THEN jobs.remote_status ELSE excluded.remote_status END,employment_type=COALESCE(NULLIF(excluded.employment_type,''),jobs.employment_type),salary=COALESCE(NULLIF(excluded.salary,''),jobs.salary),summary=COALESCE(NULLIF(excluded.summary,''),jobs.summary),description=COALESCE(NULLIF(excluded.description,''),jobs.description),tags=CASE WHEN excluded.tags='[]' THEN jobs.tags ELSE excluded.tags END,job_url=excluded.job_url,apply_url=excluded.apply_url,eligibility_status=CASE WHEN excluded.eligibility_status='unconfirmed' THEN jobs.eligibility_status ELSE excluded.eligibility_status END,published_at=COALESCE(jobs.published_at,excluded.published_at),last_seen_at=excluded.last_seen_at,last_verified_open_at=excluded.last_verified_open_at,status='open',updated_at=excluded.updated_at`)
    .bind(id,key,j.title,j.company,j.location,j.country,j.remote,j.employment,j.salary,j.summary,j.description,JSON.stringify(j.tags),j.url,j.apply,j.eligibility,j.eligibilityNote,j.published,now,now,now,now));
    statements.push(env.DB.prepare(`INSERT INTO job_sources(job_id,source_key,source_name,source_url,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id,source_key) DO UPDATE SET source_url=excluded.source_url,last_seen_at=excluded.last_seen_at`).bind(id,sourceKey,sourceName,sourceUrl,now,now));
  }
  for(let i=0;i<statements.length;i+=80)await env.DB.batch(statements.slice(i,i+80));
  return jobs.length;
}
async function storeRaw(env:Env,key:string,raw:string){const day=new Date().toISOString().slice(0,10),stamp=new Date().toISOString().replace(/[:.]/g,"-");await env.ARCHIVE.put(`raw/${day}/${key}-${stamp}.json`,raw,{httpMetadata:{contentType:"application/json"}});}
function boardEndpoint(b:Board){
  const k=encodeURIComponent(b.board_key);
  if(b.provider==="greenhouse")return `https://boards-api.greenhouse.io/v1/boards/${k}/jobs?content=true`;
  if(b.provider==="lever")return `https://api.lever.co/v0/postings/${k}?mode=json`;
  if(b.provider==="ashby")return `https://api.ashbyhq.com/posting-api/job-board/${k}?includeCompensation=true`;
  return `https://api.smartrecruiters.com/v1/companies/${k}/postings?limit=100&offset=0`;
}
function mapBoard(b:Board,v:any):Candidate|null{
  if(b.provider==="greenhouse")return normalize({title:v.title,company:b.employer_name,location:v.location?.name,country:b.country,work:v.location?.name,summary:str(v.content).slice(0,700),description:v.content,tags:[v.department?.name,v.office?.name],url:v.absolute_url,apply:v.absolute_url,published:v.first_published??v.created_at});
  if(b.provider==="lever")return normalize({title:v.text,company:b.employer_name,location:v.categories?.location??b.country,country:b.country,work:v.workplaceType??v.categories?.location,employment:v.categories?.commitment,summary:v.descriptionPlain,description:v.description,tags:[v.categories?.team,v.categories?.department],url:v.hostedUrl,apply:v.applyUrl,published:v.createdAt});
  if(b.provider==="ashby")return normalize({title:v.title,company:b.employer_name,location:v.location??(v.isRemote?"Remote":b.country),country:b.country,work:v.workplaceType??(v.isRemote?"Remote":""),employment:v.employmentType,summary:v.descriptionPlain,description:v.descriptionHtml??v.descriptionPlain,tags:[v.departmentName,v.teamName],url:v.jobUrl,apply:v.applyUrl,published:v.publishedAt,salary:v.compensation?.scrapeableCompensationSalary});
  const loc=v.location?.fullLocation??v.location?.city??b.country;
  return normalize({title:v.name,company:b.employer_name,location:loc,country:b.country,work:v.location?.remote?"Remote":loc,employment:v.typeOfEmployment?.label,summary:v.jobAd?.sections?.jobDescription?.text,description:v.jobAd?.sections?.jobDescription?.text,tags:[v.department?.label,v.function?.label],url:v.ref,apply:v.applyUrl??v.ref,published:v.releasedDate});
}
function due(last:string|null,hours:number){return !last||Date.now()-new Date(last).getTime()>=hours*3600000;}
async function collect(env:Env,force=false,trigger="cron"){
  const start=new Date().toISOString(),ins=await env.DB.prepare("INSERT INTO collection_runs(started_at,trigger_type) VALUES(?,?)").bind(start,trigger).run(),runId=Number(ins.meta.last_row_id||0);
  let attempted=0,succeeded=0,jobsSeen=0,jobsSaved=0,errors=0;
  const src=await env.DB.prepare("SELECT * FROM sources WHERE enabled=1 ORDER BY last_checked_at IS NOT NULL,last_checked_at ASC").all<any>();
  const feeds=(src.results||[]).filter((s:any)=>force||due(s.last_checked_at,s.cooldown_hours)).slice(0,8);
  await Promise.all(feeds.map(async(s:any)=>{
    attempted++;
    try{
      let rows:any[]=[];
      let rawArchive="";
      if(s.source_key==="remotejobsorg"){
        // Two documented 50-job pages stay comfortably below the provider's 200 req/hour/IP limit.
        const pages:any[]=[];
        for(const offset of [0,50]){
          const feedUrl=new URL(s.endpoint);
          feedUrl.searchParams.set("offset",String(offset));
          const pageData=await getJson(feedUrl.toString());
          const pageRows=list(pageData.data,["data"]);
          pages.push(pageData.data);
          rows.push(...pageRows);
          if(!pageData.data?.pagination?.has_more||pageRows.length===0)break;
        }
        rawArchive=JSON.stringify(pages);
      }else if(s.source_key==="himalayas"){
        // Cursor pagination: 5 pages x 20 jobs per daily sync, without inventing cursor values.
        let cursor:string|undefined;
        const pages:any[]=[];
        for(let page=0;page<5;page++){
          const feedUrl=new URL(s.endpoint);
          if(cursor)feedUrl.searchParams.set("cursor",cursor);
          const pageData=await getJson(feedUrl.toString());
          pages.push(pageData.data);
          rows.push(...list(pageData.data,["jobs","data","results"]));
          cursor=pageData.data?.nextCursor??pageData.data?.next_cursor;
          if(!cursor)break;
        }
        rawArchive=JSON.stringify(pages);
      }else{
        const feed=await getJson(s.endpoint);
        rawArchive=feed.raw;
        rows=list(feed.data,s.source_key==="remoteok"?[]:["jobs","data","results"]);
      }
      const mapped=(s.source_key==="remoteok"?rows.filter((x:any)=>x.position):rows).map((x:any)=>mapFeed(s.source_key,x)).filter(Boolean).slice(0,250) as Candidate[];
      jobsSeen+=mapped.length;await storeRaw(env,s.source_key,rawArchive);
      const attributionUrl=({"jobicy":"https://jobicy.com","remoteok":"https://remoteok.com","remotive":"https://remotive.com","arbeitnow":"https://www.arbeitnow.com","himalayas":"https://himalayas.app","remotejobsorg":"https://remotejobs.org"} as Record<string,string>)[s.source_key]||s.endpoint;
      const saved=await save(env,mapped,s.source_key,s.display_name,attributionUrl);jobsSaved+=saved;succeeded++;
      await env.DB.prepare("UPDATE sources SET last_checked_at=?,last_status='ok',last_error=NULL,last_count=? WHERE source_key=?").bind(new Date().toISOString(),saved,s.source_key).run();
    }catch(e){errors++;await env.DB.prepare("UPDATE sources SET last_checked_at=?,last_status='error',last_error=? WHERE source_key=?").bind(new Date().toISOString(),String(e).slice(0,500),s.source_key).run();}
  }));
  const cap=Math.max(1,Math.min(30,Number(env.MAX_BOARD_CHECKS_PER_RUN||12)));
  const bres=await env.DB.prepare(`SELECT b.*,e.name AS employer_name,e.official_domain,e.careers_url,e.country FROM employer_boards b JOIN employers e ON e.id=b.employer_id WHERE b.active=1 ORDER BY b.last_checked_at IS NOT NULL,b.last_checked_at ASC LIMIT ?`).bind(cap).all<Board>();
  await Promise.all((bres.results||[]).filter((b:any)=>force||due(b.last_checked_at,6)).map(async(b:any)=>{
    attempted++;const key=`ats-${b.provider}-${b.board_key}`;
    try{
      const {data,raw}=await getJson(boardEndpoint(b));
      const rows=b.provider==="lever"?(Array.isArray(data)?data:[]):list(data,b.provider==="smartrecruiters"?["content","data"]:["jobs","data","results"]);
      const mapped=rows.map((x:any)=>mapBoard(b,x)).filter(Boolean).slice(0,250) as Candidate[];
      jobsSeen+=mapped.length;await storeRaw(env,key,raw);const saved=await save(env,mapped,key,b.employer_name,b.careers_url||"");jobsSaved+=saved;succeeded++;
      await env.DB.prepare("UPDATE employer_boards SET last_checked_at=?,last_status='ok',last_error=NULL,last_count=? WHERE id=?").bind(new Date().toISOString(),saved,b.id).run();
    }catch(e){errors++;await env.DB.prepare("UPDATE employer_boards SET last_checked_at=?,last_status='error',last_error=? WHERE id=?").bind(new Date().toISOString(),String(e).slice(0,500),b.id).run();}
  }));
  const keep=Math.max(31,Math.min(90,Number(env.ARCHIVE_RETENTION_DAYS||45))),cutoff=new Date(Date.now()-keep*86400000).toISOString();
  await env.DB.prepare("DELETE FROM jobs WHERE COALESCE(published_at,first_seen_at)<?").bind(cutoff).run();
  const r2Cutoff = Date.now() - keep * 86400000;
  try {
    let cursor: string | undefined;
    do {
      const page = await env.ARCHIVE.list({ prefix: "raw/", cursor, limit: 1000 });
      const expired = page.objects.filter((object) => object.uploaded.getTime() < r2Cutoff).map((object) => object.key);
      if (expired.length) await env.ARCHIVE.delete(expired);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.error("R2 archive retention cleanup failed", e);
  }
  await env.DB.prepare("UPDATE jobs SET status='stale',updated_at=? WHERE status='open' AND last_seen_at<?").bind(new Date().toISOString(),new Date(Date.now()-10*86400000).toISOString()).run();
  const summary={attempted,succeeded,jobsSeen,jobsSaved,errors,message:attempted?`Checked ${attempted} sources; ${succeeded} succeeded and ${errors} failed.`:"No sources were due for collection."};
  await env.DB.prepare("UPDATE collection_runs SET finished_at=?,sources_attempted=?,sources_succeeded=?,jobs_seen=?,jobs_saved=?,errors=?,details=? WHERE id=?").bind(new Date().toISOString(),attempted,succeeded,jobsSeen,jobsSaved,errors,JSON.stringify(summary),runId).run();
  return summary;
}
function isAdmin(req:Request,env:Env){return !!env.ADMIN_TOKEN&&req.headers.get("Authorization")===`Bearer ${env.ADMIN_TOKEN}`;}
async function api(req:Request,url:URL,env:Env):Promise<Response>{
  if(url.pathname==="/api/health"){try{const r=await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<any>();return response({ok:true,service:"roleatlas",database:"connected",jobs:r?.n||0,windowDays:30});}catch(e){return response({ok:false,error:String(e)},503);}}
  if(url.pathname==="/api/metrics"){
    const cut=new Date(Date.now()-30*86400000).toISOString();
    const [a,b,c,d,e]=await Promise.all([
      env.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE COALESCE(published_at,first_seen_at)>=? AND status!='closed'").bind(cut).first<any>(),
      env.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE COALESCE(published_at,first_seen_at)>=? AND eligibility_status='eligible' AND status!='closed'").bind(cut).first<any>(),
      env.DB.prepare("SELECT COUNT(DISTINCT company) n FROM jobs WHERE COALESCE(published_at,first_seen_at)>=?").bind(cut).first<any>(),
      env.DB.prepare("SELECT COUNT(*) n FROM sources WHERE enabled=1").first<any>(),
      env.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE first_seen_at>=?").bind(new Date(Date.now()-86400000).toISOString()).first<any>()
    ]);
    return response({jobs:a?.n||0,nigeriaEligible:b?.n||0,employers:c?.n||0,configuredSources:d?.n||0,discovered24h:e?.n||0,windowDays:30});
  }
  if(url.pathname==="/api/jobs"){
    const days=Math.max(1,Math.min(30,Number(url.searchParams.get("days")||30))),page=Math.max(1,Number(url.searchParams.get("page")||1)),limit=Math.max(1,Math.min(50,Number(url.searchParams.get("limit")||20))),cut=new Date(Date.now()-days*86400000).toISOString();
    const q=(url.searchParams.get("q")||"").trim().slice(0,100),country=(url.searchParams.get("country")||"").trim().slice(0,80),remote=url.searchParams.get("remote")||"any",elig=url.searchParams.get("eligibility")||"any",type=(url.searchParams.get("type")||"").trim();
    const where=["COALESCE(j.published_at,j.first_seen_at)>=?","j.status!='closed'"],p:any[]=[cut];
    if(q){where.push("lower(j.title||' '||j.company||' '||COALESCE(j.location,'')||' '||COALESCE(j.tags,'')||' '||COALESCE(j.description,'')) LIKE ?");p.push(`%${q.toLowerCase()}%`);}
    if(country){where.push("lower(COALESCE(j.location,'')||' '||COALESCE(j.country,'')) LIKE ?");p.push(`%${country.toLowerCase()}%`);}
    if(remote!=="any"){where.push("j.remote_status=?");p.push(remote);}
    if(elig!=="any"){where.push("j.eligibility_status=?");p.push(elig);}
    if(type){where.push("lower(COALESCE(j.employment_type,'')) LIKE ?");p.push(`%${type.toLowerCase()}%`);}
    const w=where.join(" AND "),count=await env.DB.prepare(`SELECT COUNT(*) n FROM jobs j WHERE ${w}`).bind(...p).first<any>();
    const data=await env.DB.prepare(`SELECT j.*,GROUP_CONCAT(DISTINCT s.source_name || '§' || COALESCE(s.source_url,'')) sources FROM jobs j LEFT JOIN job_sources s ON s.job_id=j.id WHERE ${w} GROUP BY j.id ORDER BY COALESCE(j.published_at,j.first_seen_at) DESC LIMIT ? OFFSET ?`).bind(...p,limit,(page-1)*limit).all<any>();
    const results=(data.results||[]).map((j:any)=>({...j,tags:JSON.parse(j.tags||"[]"),sources:j.sources?String(j.sources).split(",").map((entry:string)=>{const parts=entry.split("§");return {name:parts.shift()||"Source",url:parts.join("§")};}):[]}));
    return response({results,total:count?.n||0,page,limit,days,hasMore:page*limit<(count?.n||0)});
  }
  if(url.pathname.startsWith("/api/admin/")){
    if(!isAdmin(req,env))return response({error:env.ADMIN_TOKEN?"Unauthorized":"Set ADMIN_TOKEN before using admin routes."},env.ADMIN_TOKEN?401:503);
    if(url.pathname==="/api/admin/collect"&&req.method==="POST")return response(await collect(env,true,"manual"));
    if(url.pathname==="/api/admin/sources"&&req.method==="GET"){
      const [sources,boards,runs]=await Promise.all([env.DB.prepare("SELECT * FROM sources ORDER BY display_name").all(),env.DB.prepare("SELECT b.*,e.name FROM employer_boards b JOIN employers e ON e.id=b.employer_id ORDER BY e.name").all(),env.DB.prepare("SELECT * FROM collection_runs ORDER BY id DESC LIMIT 12").all()]);
      return response({sources:sources.results||[],employerBoards:boards.results||[],runs:runs.results||[]});
    }
    if(url.pathname==="/api/admin/employers"&&req.method==="POST"){
      let b:any;try{b=await req.json();}catch{return response({error:"Expected JSON body"},400);}
      const name=str(b.name,180),provider=str(b.provider,30),key=str(b.boardKey,120);
      if(!name||!["greenhouse","lever","ashby","smartrecruiters"].includes(provider)||!/^[a-zA-Z0-9_-]{2,120}$/.test(key))return response({error:"Enter a company name, supported ATS and verified public board identifier."},400);
      const domain=str(b.officialDomain,180)||null;
      await env.DB.prepare("INSERT INTO employers(name,official_domain,careers_url,country,industry) VALUES(?,?,?,?,?) ON CONFLICT(name,official_domain) DO UPDATE SET careers_url=excluded.careers_url,country=excluded.country,industry=excluded.industry").bind(name,domain,str(b.careersUrl,1000)||null,str(b.country,100)||null,str(b.industry,120)||null).run();
      const e=await env.DB.prepare("SELECT id FROM employers WHERE name=? AND official_domain IS ? ORDER BY id DESC LIMIT 1").bind(name,domain).first<any>();
      await env.DB.prepare("INSERT INTO employer_boards(employer_id,provider,board_key) VALUES(?,?,?) ON CONFLICT(provider,board_key) DO UPDATE SET employer_id=excluded.employer_id,active=1").bind(e.id,provider,key).run();
      return response({ok:true,message:"Employer source registered. It will be checked during the next collection."},201);
    }
    return response({error:"Admin route not found"},404);
  }
  return response({error:"API route not found"},404);
}
export default {
  async fetch(req:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    if(req.method==="OPTIONS")return new Response(null,{status:204,headers:H});
    const url=new URL(req.url);
    try{if(url.pathname.startsWith("/api/"))return await api(req,url,env);return env.ASSETS.fetch(req);}catch(e){return response({error:e instanceof Error?e.message:"Unexpected error"},500);}
  },
  async scheduled(_event:ScheduledController,env:Env,ctx:ExecutionContext){ctx.waitUntil(collect(env,false,"cron"));}
};