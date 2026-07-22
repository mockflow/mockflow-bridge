/**
 * End-to-end test of the EDIT path: draw-then-change, without a browser.
 *
 * fake-chat.js only answers `tool` frames, so a turn that reads the board or
 * edits a component in place stalls there and the agent falls back to drawing
 * again - which reads as a pass while the board actually gains a duplicate.
 * This tab answers `read` (a board with one component on it) and `modify`, and
 * reports which of the two the agent chose.
 *
 * Usage: node test/fake-modify.js [pairing-code] ["message"]
 * Requires the daemon running and an agent installed.
 */
const fs=require("fs"),path=require("path"),WebSocket=require("ws");
const PORT=process.env.MFBRIDGE_PORT||21196, TOKEN_FILE=path.join(__dirname,".fake-tab-token");
const code=process.argv[2]||null, msg=process.argv[3]||"Add a Review step between Work and Done in that flowchart.";
let token=null; try{token=fs.readFileSync(TOKEN_FILE,"utf8").trim()}catch(e){}
const ws=new WebSocket("ws://127.0.0.1:"+PORT+"/board",{headers:{Origin:"https://app.mockflow.com"}});
const send=f=>ws.send(JSON.stringify(f));
const called=[];
ws.on("open",()=>send({t:"hello",token:token||undefined}));
ws.on("message",raw=>{const f=JSON.parse(raw.toString());
 switch(f.t){
  case "pair-required": if(!code){console.log("need code");process.exit(1)} return send({t:"pair",code});
  case "paired": fs.writeFileSync(TOKEN_FILE,f.token); return send({t:"register",projectid:"modboard",title:"Mod Board",focused:true,visible:true});
  case "ready": return send({t:"register",projectid:"modboard",title:"Mod Board",focused:true,visible:true});
  case "registered": console.log("registered; sending: "+msg); return send({t:"chat",id:"t1",text:msg});
  case "read":  // read_board -> a board that already has one flowchart on it
    console.log("  READ_BOARD answered");
    return send({t:"result",id:f.id,ok:true,data:{components:[{id:"cmp_1",comptype:"MF_DiagramFrame",label:"Start / Work / Done flowchart"}]}});
  case "modify":
    called.push("modify_component("+f.cid+")");
    console.log("  >> MODIFY_COMPONENT called on "+f.cid);
    return send({t:"result",id:f.id,ok:true,data:{modified:true}});
  case "tool":
    called.push(f.toolName);
    console.log("  >> TOOL "+f.toolName+(/^render_/.test(f.toolName)?"   <-- DREW A NEW COMPONENT":""));
    return send({t:"result",id:f.id,ok:true,data:{rendered:f.toolName}});
  case "toolhtml": called.push(f.toolName); console.log("  >> TOOLHTML "+f.toolName); return send({t:"result",id:f.id,ok:true,data:{rendered:f.toolName}});
  case "chat-step": return;
  case "chat-done":
    console.log("DONE ok="+f.ok);
    console.log("VERDICT: "+(called.some(c=>c.startsWith("modify_component"))?"EDITED IN PLACE":"DUPLICATED (called "+called.join(",")+")"));
    return setTimeout(()=>process.exit(0),200);
 }});
setTimeout(()=>{console.log("timeout");process.exit(1)},180000);
