import grpc
from concurrent import futures
import turn_pb2
import turn_pb2_grpc
import json
from turn import ConversationTurnDetector  # rename this to your actual script filename (without `.py`)

class TurnDetectorServicer(turn_pb2_grpc.TurnDetectorServicer):
    def __init__(self):
        self.detector = ConversationTurnDetector()

    def CheckEndOfTurn(self, request, context):
        # Convert the protobuf message to the expected input format
        messages = [{"role": m.role, "content": m.content} for m in request.messages]
        try:
            is_done = self.detector.detect_turn_completion(messages)
            return turn_pb2.TurnResponse(end_of_turn=is_done)
        except Exception as e:
            print(f"Error: {e}")
            return turn_pb2.TurnResponse(end_of_turn=False)

def serve():
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=1))
    turn_pb2_grpc.add_TurnDetectorServicer_to_server(TurnDetectorServicer(), server)
    server.add_insecure_port('[::]:50051')
    server.start()
    print("🟢 Turn Detector gRPC server is running on port 50051")
    server.wait_for_termination()

if __name__ == '__main__':
    serve()
    
    
    
# python3 -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. turn.proto