# EasyROS - 7/11/17
#   Useful utilities for autonomously controlling RACECARs at BWSI 2017
#   Team 6: Stephan, Phoebe, Esther, Cameron, Joshua
import rospy
from rospy import loginfo
from ackermann_msgs.msg import AckermannDriveStamped
from time import time

pub = rospy.Publisher('/vesc/ackermann_cmd_mux/input/navigation', AckermannDriveStamped, queue_size=10)
r = rospy.Rate(10) # 10hz

def move(speed, steering_angle, duration):
    # initialize the message using the arguments provided
    msg = AckermannDriveStamped()
    msg.drive.speed = speed
    msg.drive.steering_angle = steering_angle
    
    # pretty sure this is what the frame_id should be?
    # probably doesn't really matter anyway
    msg.header.frame_id = '/base_link'
    
    # continue publishing our move message until either the robot shuts down or the timer runs out
    start_time = time()
    while not rospy.is_shutdown() and start_time + duration > time():
        msg.header.stamp = rospy.Time.now()
        pub.publish(msg)
        # makes the loop run only 10 times a second (configurable)
        r.sleep()
    
    loginfo('Done move (speed %s, steering_angle %s, duration %s)', speed, steering_angle, duration)

