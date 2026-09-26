import json,urllib.request,sys
def gql(q):
    req=urllib.request.Request("https://interface.gateway.uniswap.org/v1/graphql",data=json.dumps({"query":q}).encode(),headers={'Content-Type':'application/json','Origin':'https://app.uniswap.org','Referer':'https://app.uniswap.org/','User-Agent':'Mozilla/5.0'})
    try: return json.load(urllib.request.urlopen(req,timeout=60))
    except Exception as e: return {"err":str(e),"body":getattr(e,'read',lambda:b'')()[:500]}
