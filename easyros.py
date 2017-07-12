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
    msg = AckermannDriveStamped()
    msg.header.frame_id = '/base_link'
    msg.drive.speed = speed
    msg.drive.steering_angle = steering_angle
    
    start_time = time()
    while not rospy.is_shutdown() and start_time + duration > time():
        msg.header.stamp = rospy.Time.now()
        pub.publish(msg)
        r.sleep()
    
    loginfo('Done move (speed %s, steering_angle %s, duration %s)', speed, steering_angle, duration)

