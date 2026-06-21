from openai import OpenAI

client = OpenAI(
    base_url="https://my-agent-production-265a.up.railway.app/v1",  # or http://localhost:3001/v1 for local
    api_key="freellmapi-9ad15aed2de0675739112ae7c7076a663985e3543c579228",  # update if key changed
)

# Test 1: single text
print("Test 1: Single embedding")
res = client.embeddings.create(
    model="gemini-embedding-001",  # current Google embedding model
    input="Hello world"
)
vec = res.data[0].embedding
print(f"  Model: {res.model}")
print(f"  Dimensions: {len(vec)}")
print(f"  First 5 values: {vec[:5]}")
print(f"  Routed via: {getattr(res, '_routed_via', 'N/A')}")

# Test 2: similarity — similar sentences should have close scores
print("\nTest 2: Similarity check")
import math

def cosine_similarity(a, b):
    dot = sum(x*y for x,y in zip(a,b))
    mag_a = math.sqrt(sum(x**2 for x in a))
    mag_b = math.sqrt(sum(x**2 for x in b))
    return dot / (mag_a * mag_b)

res2 = client.embeddings.create(
    model="auto",
    input=["I love dogs", "I like cats", "Buy bitcoin now"]
)

v1 = res2.data[0].embedding  # I love dogs
v2 = res2.data[1].embedding  # I like cats
v3 = res2.data[2].embedding  # Buy bitcoin now

sim_12 = cosine_similarity(v1, v2)
sim_13 = cosine_similarity(v1, v3)

print(f"  'I love dogs' vs 'I like cats':   {sim_12:.4f}  (should be HIGH ~0.8+)")
print(f"  'I love dogs' vs 'Buy bitcoin':   {sim_13:.4f}  (should be LOW ~0.5)")
print(f"\n✅ Embeddings working!" if sim_12 > sim_13 else "\n❌ Something seems off")
