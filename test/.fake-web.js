const fs=require("fs"),path=require("path"),WebSocket=require("ws");
const PORT=process.env.MFBRIDGE_PORT||21196, TOKEN_FILE=path.join(__dirname,".fake-tab-token");
const code=process.argv[2]||null;
let token=null; try{token=fs.readFileSync(TOKEN_FILE,"utf8").trim()}catch(e){}
const ws=new WebSocket("ws://127.0.0.1:"+PORT+"/board",{headers:{Origin:"https://app.mockflow.com"}});
const send=f=>ws.send(JSON.stringify(f));
ws.on("open",()=>send({t:"hello",token:token||undefined}));
ws.on("message",raw=>{const f=JSON.parse(raw.toString());
 switch(f.t){
  case "pair-required": if(!code){console.log("need code");process.exit(1)} return send({t:"pair",code});
  case "paired": fs.writeFileSync(TOKEN_FILE,f.token); return reg();
  case "ready": return reg();
  case "registered":
    return send({t:"chat",id:"w1",text:"Fetch the page https://example.com and reply with the exact main heading text on it. Do not draw anything. If you cannot fetch, reply CANNOT-FETCH."});
  case "chat-step":
    if(f.step&&f.step.phase==="start") console.log("  tool:",f.step.tool);
    return;
  case "tool": case "toolhtml": return send({t:"result",id:f.id,ok:true,data:{}});
  case "chat-done":{
    const t=String(f.text||"");
    const fetched=/example domain/i.test(t);
    console.log("  reply:",JSON.stringify(t.slice(0,120)));
    console.log("  VERDICT:",fetched?"FETCHED THE PAGE":(/cannot-fetch/i.test(t)?"SAID IT CANNOT":"no page content"));
    return setTimeout(()=>process.exit(0),200);
  }
 }});
function reg(){send({t:"register",projectid:"webboard",title:"Web",focused:true,visible:true})}
setTimeout(()=>{console.log("timeout");process.exit(1)},150000);
