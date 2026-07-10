#!/usr/bin/env python3
"""
CanSat GCS Hardware Simulator Script
------------------------------------
This script simulates a CanSat hardware device emitting telemetry over a serial port.
It generates realistic $CSV packets with XOR checksums and outputs them to a virtual
serial port (PTY) or standard output, which you can hook up to the browser using socat
or com0com (on Windows).

Usage:
  python simulate_serial.py --port COM9 --baud 115200

If testing on Windows without hardware, we recommend using 'com0com' to create
a virtual port pair (e.g. COM8 <-> COM9). Run this script on COM9 and point the GCS
to COM8.
"""

import time
import math
import random
import argparse
import serial

def compute_checksum(body):
    """Compute XOR checksum of the string (excluding $ and *)."""
    cs = 0
    for char in body:
        if char not in ('$', '*'):
            cs ^= ord(char)
    return f"{cs:02X}"

def generate_telemetry(packet_count, t_elapsed):
    """Generate realistic telemetry state based on mission time."""
    # Mission phases (simplified)
    # 0-5s:   Standby
    # 5-20s:  Ascent (5 m/s)
    # 20-30s: Freefall (25 m/s)
    # 30-65s: Parachute (9 m/s)
    # 65s+:   Landed
    
    # Defaults
    alt = 0.0
    descent_rate = 0.0
    lat = 12.9716
    lng = 77.5946
    roll = pitch = yaw = 0.0
    batt = 4.2 - (t_elapsed * 0.001)
    batt = max(3.0, batt)
    
    if t_elapsed < 5:
        # Standby
        alt = random.gauss(0, 0.1)
        descent_rate = 0.0
    elif t_elapsed < 20:
        # Ascent
        t = t_elapsed - 5
        descent_rate = -5.0 + random.gauss(0, 0.2)
        alt = 5.0 * t + random.gauss(0, 1.0)
        yaw = (t * 10) % 360
    elif t_elapsed < 30:
        # Freefall
        t = t_elapsed - 20
        descent_rate = 25.0 + random.gauss(0, 1.0)
        alt = max(0, 75.0 - 25.0 * t)  # peak is 75m from ascent
        roll = (t * 40) % 360
        pitch = (t * 30) % 360
        yaw = (t * 50) % 360
    elif t_elapsed < 65:
        # Parachute
        t = t_elapsed - 30
        descent_rate = 9.0 + random.gauss(0, 0.5)
        # Assuming parachute deployed around 0m for this simple test, or just falling slowly
        alt = max(0, 200.0 - 9.0 * t) # arbitrary chute height
        roll = random.gauss(0, 5)
        pitch = random.gauss(0, 5)
        yaw = (t * 5) % 360
    else:
        # Landed
        alt = random.gauss(0, 0.1)
        descent_rate = 0.0

    # Environment
    pressure = 1013.25 * ((288.15 - 0.0065 * max(0, alt)) / 288.15) ** 5.255
    pressure += random.gauss(0, 0.1)
    temperature = 25.0 - 0.0065 * max(0, alt)
    temperature += random.gauss(0, 0.1)

    lat += random.gauss(0, 0.00001)
    lng += random.gauss(0, 0.00001)

    # Build CSV body
    body = f"$CSV,{packet_count},{alt:.2f},{pressure:.2f},{temperature:.2f},{max(0, descent_rate):.2f},{batt:.3f},{lat:.8f},{lng:.8f},{roll:.2f},{pitch:.2f},{yaw:.2f}"
    
    checksum = compute_checksum(body)
    return f"{body}*{checksum}\r\n"

def main():
    parser = argparse.ArgumentParser(description="CanSat Hardware Simulator")
    parser.add_argument('--port', type=str, help="Serial port to output to (e.g., COM9). If omitted, prints to stdout.", default=None)
    parser.add_argument('--baud', type=int, default=115200, help="Baud rate (default: 115200)")
    parser.add_argument('--hz', type=int, default=1, help="Packets per second (default: 1)")
    
    args = parser.parse_args()
    
    ser = None
    if args.port:
        print(f"Opening port {args.port} at {args.baud} baud...")
        try:
            ser = serial.Serial(args.port, args.baud)
        except Exception as e:
            print(f"Error opening port: {e}")
            return

    print("Starting simulation... (Press Ctrl+C to stop)")
    
    start_time = time.time()
    packet_count = 0
    sleep_time = 1.0 / args.hz

    try:
        while True:
            t_elapsed = time.time() - start_time
            packet_count += 1
            
            line = generate_telemetry(packet_count, t_elapsed)
            
            if ser:
                ser.write(line.encode('ascii'))
            else:
                # Print to stdout if no port provided (can be piped to socat)
                print(line, end='', flush=True)
                
            time.sleep(sleep_time)
            
    except KeyboardInterrupt:
        print("\nSimulation stopped.")
    finally:
        if ser:
            ser.close()

if __name__ == "__main__":
    main()
