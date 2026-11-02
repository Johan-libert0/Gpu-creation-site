import modal

app = modal.App("gpu-foundry-cpu-test")
image = modal.Image.debian_slim()


@app.function(image=image)
def verify_compute_node():
    import sys

    print("--------------------------------------------------")
    print("Compute infrastructure successfully provisioned!")
    print(f"Platform OS Engine: {sys.platform}")
    print("--------------------------------------------------")

@app.local_entrypoint()
def main():
    verify_compute_node.remote()
