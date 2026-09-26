import json, subprocess, time
def rpc(url, m, p, tries=4, timeout=60):
    last=None
    for k in range(tries):
        try:
            o=subprocess.run(["curl","-s","--max-time",str(timeout),"-X","POST",url,"-H","Content-Type: application/json","-H","User-Agent: Mozilla/5.0","-d",json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p})],capture_output=True,text=True).stdout
            j=json.loads(o)
            if "result" in j: return j["result"]
            last=j.get("error")
        except Exception as e: last=str(e)
        time.sleep(2+3*k)
    raise Exception(f"fail {m} {last}")
